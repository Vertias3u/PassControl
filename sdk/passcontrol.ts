// PassControl client SDK — the thin layer that hides visa minting.
//
// A PassControl-issued passport holds an Ed25519 private key. To call a provider
// the agent must sign a challenge, mint a short-lived (5 min) work-visa, and send
// it instead of the real provider key. This SDK does that — and refreshes the visa
// transparently — so integration is *re-pointing* an existing OpenAI/Anthropic SDK,
// not rewriting the agent:
//
//   import OpenAI from "openai";
//   import { PassControl } from "passcontrol";
//   const pc = new PassControl({ gateway, passportId, passportSecret });
//   const openai = new OpenAI(pc.clientOptions("openai"));
//   // …use `openai` normally. Visas mint/refresh under the hood.
//
// Dependencies: only @noble/curves (Ed25519) + the platform `fetch`/`crypto`.
// Runs on Node 18+, edge runtimes, and the browser.
import { ed25519 } from "@noble/curves/ed25519";

export type ProviderId = "openai" | "anthropic";

export interface PassControlOptions {
  /** Gateway origin, e.g. https://passcontrol.example.com (no trailing slash). */
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

export class PassControl {
  private readonly gateway: string;
  private readonly passportId: string;
  private readonly secret: Uint8Array;
  private readonly skewMs: number;
  private readonly transport: typeof fetch;

  private cached: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(opts: PassControlOptions) {
    if (!opts.gateway || !opts.passportId || !opts.passportSecret) {
      throw new Error("PassControl: gateway, passportId, and passportSecret are required.");
    }
    this.gateway = opts.gateway.replace(/\/+$/, "");
    this.passportId = opts.passportId;
    this.secret = b64urlToBytes(opts.passportSecret);
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

    const res = await this.transport(`${this.gateway}/api/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload, signature }),
    });
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

  /** A `fetch` that injects the visa and refreshes it transparently. Pass this as
   *  the `fetch` option to the OpenAI/Anthropic SDK. Retries once on a 401 (the
   *  visa was rejected/expired) after forcing a re-mint. */
  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const send = async (visa: string): Promise<Response> => {
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
      // The visa is the credential. Set it as Authorization (the gateway prefers
      // Bearer) and strip any x-api-key the SDK added so only the visa travels.
      headers.set("authorization", `Bearer ${visa}`);
      headers.delete("x-api-key");
      return this.transport(input, { ...init, headers });
    };

    let res = await send(await this.getVisa());
    if (res.status === 401) {
      this.invalidate();
      res = await send(await this.getVisa());
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
