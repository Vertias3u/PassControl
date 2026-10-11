// PassControl client SDK — the thin layer that hides visa minting.
//
// A PassControl-issued passport holds an Ed25519 private key. To call a provider
// the agent must sign a challenge, mint a short-lived (5 min) work-visa, and send
// it instead of the real provider key. This SDK does that — and refreshes the visa
// transparently — so integration is *re-pointing* an existing OpenAI/Anthropic SDK,
// not rewriting the agent:
//
//   Construct PassControl with gateway, passportId and passportSecret, then pass
//   pc.clientOptions("openai") to the existing OpenAI client constructor.
//   // …use `openai` normally. Visas mint/refresh under the hood.
//
// Dependencies: only @noble/curves (Ed25519) + the platform `fetch`/`crypto`.
// Runs on Node 18+ and edge/server runtimes. Do not place a passport secret in
// an end-user browser bundle even though the underlying Web APIs are portable.
import { ed25519 } from "@noble/curves/ed25519";
import { requireGatewayOrigin } from "./gateway.js";
import { createDelegationLink } from "../cli/delegation.mjs";

export type ProviderId =
  | "openai"
  | "anthropic"
  | "groq"
  | "mistral"
  | "together"
  | "deepseek"
  | "gemini"
  | "xai"
  | "openrouter"
  | "azure"
  | "local";

export interface PassControlOptions {
  /**
   * Gateway origin, e.g. https://passcontrol.example.com — scheme, host and
   * optional port only. Validated at construction against the same bare-origin
   * rule as `ControlClient`; plain HTTP is accepted only on loopback. See
   * ./gateway.
   */
  gateway: string;
  /** base64url Ed25519 public key (the passport id). */
  passportId: string;
  /** base64url Ed25519 private key (32-byte seed). Stays on the agent; only signs. */
  passportSecret: string;
  /** Re-mint when fewer than this many seconds remain on the visa. Default 30. */
  refreshSkewSeconds?: number;
  /** Override the transport (tests / custom fetch). Defaults to global fetch. */
  fetch?: typeof fetch;
}

/** A worker's side of a signed delegation (Bet D). */
export interface PassControlDelegationOptions {
  gateway: string;
  /** The chain the worker was handed, root first. */
  chain: string[];
  /** The worker's own private key. Its public half is the chain's last `sub`. */
  workerPrivateKey: string;
  refreshSkewSeconds?: number;
  fetch?: typeof fetch;
}

export interface DelegateOptions {
  /** The worker's public key. The worker keeps its private key; the parent never holds it. */
  workerPublicKey: string;
  scope: { provider: ProviderId | string; models: string[] }[];
  /** The most this delegation and everything under it may spend, in micro-cents. */
  capMicrocents: number;
  /** At most 24 hours, and never past the signer's own delegation. */
  ttlSeconds: number;
  /** false: the worker may not delegate on. */
  allowFurtherDelegation?: boolean;
  /**
   * The gateway's issuer (receipts' `iss`). Defaults to the gateway origin, which is
   * the issuer unless the gateway is reached through another address.
   */
  audience?: string;
}

interface ChallengeResponse {
  visa: string;
  token_type: string;
  expires_in: number;
  jti: string;
}

// --- base64url over raw bytes (no Buffer dependency; works everywhere) -------
function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 =
    typeof btoa !== "undefined" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin =
    typeof atob !== "undefined" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Can this `init.body` be sent a second time?
 *
 * Only matters for the one-time 401 retry, and it is the whole question — because
 * `init.body`, when it is non-null, IS the body each attempt sends. `send()` passes
 * `{ ...init, headers }` next to the cloned `Request` template, and per the fetch
 * spec an init body overrides the input request's; the clone's teed copy is then
 * never read. So a `Request` input does not make a retry safe on its own: what
 * decides is the *effective* body, which is `init.body` whenever one is supplied.
 *
 * Every shape below is a re-readable value. Anything else (a ReadableStream, an
 * async iterable, a Node stream) is consumed by the first attempt; replaying one
 * either throws a platform TypeError or, worse, sends an empty body to the
 * provider — so we don't.
 *
 * `null`/`undefined` answer true, and that is what makes the caller's single call
 * to this function complete: with no init body the effective body is the template
 * `Request`'s own, which `clone()` tees and can therefore be sent again — or there
 * is no template and no body at all. (It also means the answer does not hinge on
 * whether a given runtime treats an explicit `body: null` as an override: both
 * readings leave a replay-safe body.)
 *
 * Deliberately an allow-list. A body shape this does not recognise is treated as
 * single-use, which costs one avoidable retry and can never send a wrong body.
 */
function isReplayableBody(body: unknown): boolean {
  if (body === null || body === undefined || typeof body === "string") return true;
  if (typeof ArrayBuffer !== "undefined" && (ArrayBuffer.isView(body) || body instanceof ArrayBuffer)) return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  if (typeof FormData !== "undefined" && body instanceof FormData) return true;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return true;
  return false;
}

export class PassControl {
  private readonly gateway: string;
  private readonly gatewayOrigin: string;
  private readonly passportId: string;
  private readonly secret: Uint8Array;
  private readonly skewMs: number;
  private readonly transport: typeof fetch;

  /** Set only on a worker's client: its chain, sent to /api/auth/delegated. */
  private delegationChain: string[] | null = null;

  private cached: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(opts: PassControlOptions) {
    if (!opts.gateway || !opts.passportId || !opts.passportSecret) {
      throw new Error("PassControl: gateway, passportId, and passportSecret are required.");
    }
    // Same rule, same code as ControlClient's `pc_` key — see ./gateway. Both
    // clients hand a bearer credential to whatever this option names, so the two
    // must not be allowed to drift apart.
    const origin = requireGatewayOrigin("PassControl", opts.gateway);
    this.gateway = origin;
    this.gatewayOrigin = origin;
    this.passportId = opts.passportId;
    this.secret = b64urlToBytes(opts.passportSecret);
    if (b64urlToBytes(opts.passportId).length !== 32 || this.secret.length !== 32) {
      throw new Error("PassControl: passportId and passportSecret must each encode 32 bytes.");
    }
    this.skewMs = Math.max(0, (opts.refreshSkewSeconds ?? 30) * 1000);
    // Bind so the global fetch keeps its expected `this`.
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error("PassControl: no fetch available; pass options.fetch.");
    this.transport = (...args: Parameters<typeof fetch>) => f(...args);
  }

  /** Sign a fresh challenge and exchange it for a visa. */
  private async mint(): Promise<{ token: string; expiresAt: number }> {
    const payloadObj = { passport_id: this.passportId, ts: Date.now(), nonce: crypto.randomUUID() };
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payloadObj));
    const payload = bytesToB64url(payloadBytes);
    const signature = bytesToB64url(ed25519.sign(payloadBytes, this.secret));

    // A worker exchanges its chain, signing the challenge with its OWN key: the
    // delegation token alone does nothing at the gateway.
    const res = await this.transport(
      `${this.gateway}/api/auth/${this.delegationChain ? "delegated" : "challenge"}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          this.delegationChain ? { payload, signature, chain: this.delegationChain } : { payload, signature }
        ),
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`PassControl: challenge failed (${res.status}) ${detail}`.trim());
    }
    const data = (await res.json()) as ChallengeResponse;
    if (!data.visa) throw new Error("PassControl: challenge returned no visa.");
    return { token: data.visa, expiresAt: Date.now() + (data.expires_in ?? 300) * 1000 };
  }

  /** Return a valid visa, minting or refreshing as needed. Concurrent callers
   *  share a single in-flight mint (no thundering herd of challenges). */
  async getVisa(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt - this.skewMs) {
      return this.cached.token;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.mint()
      .then((v) => {
        this.cached = v;
        return v.token;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Drop the cached visa so the next getVisa() re-mints. */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * A client for a WORKER holding a delegation (Bet D). Its calls are refused past the
   * delegation's scope, cap or expiry, and the agent's kill switch and suspension stop
   * it too. Its receipts name the worker, never the agent's passport.
   */
  static fromDelegation(opts: PassControlDelegationOptions): PassControl {
    if (!Array.isArray(opts.chain) || opts.chain.length < 1) {
      throw new Error("PassControl: fromDelegation needs the chain the worker was handed.");
    }
    const priv = b64urlToBytes(opts.workerPrivateKey);
    if (priv.length !== 32) throw new Error("PassControl: workerPrivateKey must encode 32 bytes.");
    const client = new PassControl({
      gateway: opts.gateway,
      passportId: bytesToB64url(ed25519.getPublicKey(priv)),
      passportSecret: opts.workerPrivateKey,
      ...(opts.refreshSkewSeconds !== undefined ? { refreshSkewSeconds: opts.refreshSkewSeconds } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    client.delegationChain = [...opts.chain];
    return client;
  }

  /**
   * Hand a worker a narrower slice of this client's authority: signed here, offline,
   * by this client's key (the agent's passport, or a worker's own key one level down).
   * Returns the chain to give the worker, root first.
   */
  delegate(opts: DelegateOptions): { token: string; chain: string[] } {
    const token = createDelegationLink({
      signerPrivateKey: bytesToB64url(this.secret),
      audience: opts.audience ?? this.gatewayOrigin,
      workerPublicKey: opts.workerPublicKey,
      scope: opts.scope,
      capMicrocents: opts.capMicrocents,
      ttlSeconds: opts.ttlSeconds,
      ...(opts.allowFurtherDelegation !== undefined ? { allowFurtherDelegation: opts.allowFurtherDelegation } : {}),
      ...(this.delegationChain ? { parentChain: this.delegationChain } : {}),
    });
    return { token, chain: [...(this.delegationChain ?? []), token] };
  }

  /** A `fetch` that injects the visa and refreshes it transparently. Pass this as
   *  the `fetch` option to the OpenAI/Anthropic SDK. Retries once on a 401 (the
   *  visa was rejected/expired) after forcing a re-mint. */
  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const inputRequest = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const rawUrl = inputRequest ? inputRequest.url : String(input);
    const target = new URL(rawUrl, `${this.gateway}/`);
    // `URL.origin` discards userinfo, so `https://a:b@gateway/...` compares equal to
    // the gateway and would otherwise pass. Reject it here for the same reason the
    // constructor does, instead of relying on the platform's Request to throw.
    if (
      target.origin !== this.gatewayOrigin ||
      target.username ||
      target.password ||
      !target.pathname.startsWith("/api/v1/")
    ) {
      throw new Error("PassControl: refusing to send a visa outside the configured gateway provider path.");
    }
    // Keep a pristine template so a Request input retains its method and body and
    // each send gets an unread clone — clone() tees the body, streams included.
    // That tee only covers the template's OWN body: a non-null `init.body` travels
    // beside the clone and overrides it, so the effective body of every attempt is
    // `init.body` when there is one. isReplayableBody decides on that basis alone.
    const requestTemplate = inputRequest?.clone() ?? null;
    const canReplay = isReplayableBody(init.body);
    const send = async (visa: string): Promise<Response> => {
      const requestHeaders = inputRequest?.headers;
      const headers = new Headers(init.headers ?? requestHeaders);
      // The visa is the credential. Set it as Authorization (the gateway prefers
      // Bearer) and strip any x-api-key the SDK added so only the visa travels.
      headers.set("authorization", `Bearer ${visa}`);
      headers.delete("x-api-key");
      return this.transport(requestTemplate?.clone() ?? target.toString(), { ...init, headers });
    };

    let res = await send(await this.getVisa());
    if (res.status === 401) {
      // The gateway rejected this visa, so stop serving it either way — a caller
      // we cannot retry for still deserves a fresh visa on its next call.
      this.invalidate();
      if (canReplay) {
        // Release the rejected response's body before replacing it; an unread
        // body holds its connection open until the runtime collects it.
        void res.body?.cancel().catch(() => {});
        res = await send(await this.getVisa());
      }
    }
    return res;
  };

  /** Options to spread into an OpenAI/Anthropic SDK constructor. The fetch wrapper
   *  owns auth, so `apiKey` is a non-secret placeholder (the SDK requires one). */
  clientOptions(provider: ProviderId): { baseURL: string; apiKey: string; fetch: typeof fetch } {
    return {
      baseURL: `${this.gateway}/api/v1/${provider}`,
      apiKey: "passcontrol-visa",
      fetch: this.fetch,
    };
  }
}
