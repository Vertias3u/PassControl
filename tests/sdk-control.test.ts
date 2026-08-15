import { inspect } from "node:util";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { ControlClient, ControlApiError } from "../sdk/control";
import { PassControl } from "../sdk/passcontrol";

// Mock transport recording calls; configurable response per test.
let next: { status: number; body: unknown } = { status: 200, body: { data: null } };
const calls: { url: string; method: string; headers: Headers; body?: string }[] = [];
const fetchMock = vi.fn(async (url: string, init: any = {}) => {
  calls.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body });
  return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
});

const pc = () => new ControlClient({ gateway: "https://gw.example.com/", apiKey: "pc_" + "a".repeat(40), fetch: fetchMock as any });

beforeEach(() => {
  calls.length = 0;
  next = { status: 200, body: { data: null } };
});

describe("ControlClient — request shaping", () => {
  it("targets /api/control/v1, sends the bearer key, and unwraps `data`", async () => {
    next = { status: 200, body: { data: [{ id: "a1" }] } };
    const out = await pc().agents.list({ status: "active", limit: 10 });
    expect(out).toEqual([{ id: "a1" }]);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("https://gw.example.com/api/control/v1/agents?status=active&limit=10");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer pc_" + "a".repeat(40));
  });

  it("omits undefined query params", async () => {
    next = { status: 200, body: { data: [] } };
    await pc().logs.list({ agent_id: "ag1" }); // status/limit omitted
    expect(calls[0]!.url).toBe("https://gw.example.com/api/control/v1/logs?agent_id=ag1");
  });

  it("POSTs create with a JSON body and Idempotency-Key", async () => {
    next = { status: 201, body: { data: { id: "a9", name: "bot" } } };
    const out = await pc().agents.create(
      { name: "bot", passportPubkey: "pk", scopes: [{ provider: "anthropic", models: ["claude-*"] }] },
      { idempotencyKey: "op-1" }
    );
    expect(out).toEqual({ id: "a9", name: "bot" });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
    expect(calls[0]!.headers.get("idempotency-key")).toBe("op-1");
    expect(JSON.parse(calls[0]!.body!).name).toBe("bot");
  });

  it("PATCH update sends the partial body", async () => {
    next = { status: 200, body: { data: { id: "a1" } } };
    await pc().agents.update("a1", { budget_tokens: 1000 });
    expect(calls[0]!.method).toBe("PATCH");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ budget_tokens: 1000 });
  });

  it("suspend / resume / revoke hit the right method + path", async () => {
    next = { status: 200, body: { data: { id: "a1", status: "suspended" } } };
    await pc().agents.suspend("a1");
    expect(calls[0]!).toMatchObject({ method: "POST", url: "https://gw.example.com/api/control/v1/agents/a1/suspend" });
    await pc().agents.revoke("a1");
    expect(calls[1]!).toMatchObject({ method: "DELETE", url: "https://gw.example.com/api/control/v1/agents/a1" });
  });

  it("killSwitch.set PUTs { armed }", async () => {
    next = { status: 200, body: { data: { armed: true, affected: 2 } } };
    const out = await pc().killSwitch.set(true, { idempotencyKey: "k1" });
    expect(out).toEqual({ armed: true, affected: 2 });
    expect(calls[0]!.method).toBe("PUT");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ armed: true });
    expect(calls[0]!.headers.get("idempotency-key")).toBe("k1");
  });
});

describe("ControlClient — errors", () => {
  it("throws ControlApiError with code + status + requestId on non-2xx", async () => {
    next = { status: 403, body: { error: { code: "insufficient_scope", message: "need write", request_id: "req-42" } } };
    await expect(pc().agents.create({ name: "x", passportPubkey: "p", scopes: [] })).rejects.toMatchObject({
      name: "ControlApiError",
      status: 403,
      code: "insufficient_scope",
      requestId: "req-42",
    });
  });

  it("ControlApiError is an Error subclass", async () => {
    next = { status: 404, body: { error: { code: "not_found", message: "nope" } } };
    const err = await pc().agents.get("missing").catch((e) => e);
    expect(err).toBeInstanceOf(ControlApiError);
    expect(err).toBeInstanceOf(Error);
  });
});

// ── The gateway is a credential destination ─────────────────────────────────
//
// `ControlClient` used to accept any non-empty `gateway`, build `base` by string
// concatenation, and then attach `Authorization: Bearer <pc_ key>` to whatever
// that produced. A `pc_` key is long-lived, tenant-wide, and the only credential
// the control plane accepts — so the gateway value is not configuration hygiene,
// it decides who receives that credential. `http://gateway.example` sends it
// over cleartext; `https://trusted.example@attacker.example` sends it to
// attacker.example while reading as the trusted host.
//
// The rule is the one `PassControl` already enforced for visas, now shared by
// both credential-bearing clients (`sdk/gateway.ts`): a bare HTTPS origin,
// parsed — never prefix- or suffix-matched — with plain HTTP allowed only on the
// three explicit loopback hosts.

const FAKE_KEY = `pc_${"f".repeat(40)}`; // never a real credential

/** Records that a request happened and whether it carried *any* authorization —
 *  deliberately not the header value, so a failing assertion prints the leak
 *  without printing a key. */
function captureTransport() {
  const seen: { url: string; sentAuthorization: boolean }[] = [];
  const fn = vi.fn(async (url: any, init: any = {}) => {
    seen.push({
      url: String(url),
      sentAuthorization: new Headers(init?.headers ?? {}).get("authorization") !== null,
    });
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { seen, fn };
}

// A real passport keypair, so PassControl's own key-size check never masks the
// gateway verdict this matrix is about.
const passportSecretBytes = ed25519.utils.randomPrivateKey();
const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const PASSPORT_SECRET = b64url(passportSecretBytes);
const PASSPORT_ID = b64url(ed25519.getPublicKey(passportSecretBytes));

/** Construct each credential-bearing client with the same gateway, and report
 *  what each one did: the normalized origin it settled on, or the error. */
function constructBoth(gateway: string) {
  const control = captureTransport();
  const passport = captureTransport();
  const result: {
    controlOrigin?: string;
    controlError?: Error;
    passportOrigin?: string;
    passportError?: Error;
    reachedTransport: boolean;
  } = { reachedTransport: false };

  try {
    const client = new ControlClient({ gateway, apiKey: FAKE_KEY, fetch: control.fn as any });
    // Only reachable when the constructor accepted the value; `base` is private,
    // so the URL a real call produces is how the origin is observed.
    void client.agents.list();
    result.controlOrigin = new URL(control.seen[0]?.url ?? "https://unreached.invalid").origin;
  } catch (error) {
    result.controlError = error as Error;
  }
  try {
    const client = new PassControl({
      gateway,
      passportId: PASSPORT_ID,
      passportSecret: PASSPORT_SECRET,
      fetch: passport.fn as any,
    });
    result.passportOrigin = new URL(client.clientOptions("openai").baseURL).origin;
  } catch (error) {
    result.passportError = error as Error;
  }
  result.reachedTransport = passport.seen.length > 0;
  return result;
}

describe("ControlClient — the gateway decides where the control key goes", () => {
  it("never reaches a plain-HTTP gateway with the control key", async () => {
    const { seen, fn } = captureTransport();
    let thrown: unknown;
    try {
      // Unfixed, this constructs happily and the call below sends
      // `Authorization: Bearer pc_…` to http://gateway.example in cleartext.
      const client = new ControlClient({
        gateway: "http://gateway.example",
        apiKey: FAKE_KEY,
        fetch: fn as any,
      });
      await client.agents.list();
    } catch (error) {
      thrown = error;
    }
    expect(seen).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("bare HTTPS origin");
  });

  it("rejects a deceptive userinfo gateway before a custom transport can be used", async () => {
    const { seen, fn } = captureTransport();
    let thrown: unknown;
    try {
      // Reads as trusted.example; `origin` is attacker.example.
      const client = new ControlClient({
        gateway: "https://trusted.example@attacker.example",
        apiKey: FAKE_KEY,
        fetch: fn as any,
      });
      await client.agents.list();
    } catch (error) {
      thrown = error;
    }
    expect(seen).toEqual([]);
    expect(thrown).toBeInstanceOf(Error);
  });

  it("never serializes the control key — not into a log, a dump, or an API error", async () => {
    const client = new ControlClient({
      gateway: "https://gw.example.com",
      apiKey: FAKE_KEY,
      fetch: (async () =>
        new Response(JSON.stringify({ error: { code: "insufficient_scope", message: "need write" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })) as any,
    });
    const failure = await client.agents.list().catch((error) => error as ControlApiError);

    // The two things every debugging session and error reporter does to an object.
    expect(JSON.stringify(client)).not.toContain(FAKE_KEY);
    expect(inspect(client, { depth: 6 })).not.toContain(FAKE_KEY);
    expect(Object.keys(client)).not.toContain("apiKey");
    expect(`${JSON.stringify(failure)}${inspect(failure)}${(failure as Error).stack}`).not.toContain(FAKE_KEY);
  });

  it("keeps the key and the embedded credentials out of the refusal message", () => {
    const attempt = (gateway: string) => {
      try {
        new ControlClient({ gateway, apiKey: FAKE_KEY, fetch: captureTransport().fn as any });
        return "";
      } catch (error) {
        return `${(error as Error).message}\n${String(error)}\n${(error as Error).stack ?? ""}`;
      }
    };
    for (const gateway of [
      "https://trusted.example@attacker.example",
      "https://admin:hunter2@gw.example.com",
      "http://gateway.example",
      "not a url",
    ]) {
      const text = attempt(gateway);
      expect(text).not.toBe("");
      expect(text).not.toContain(FAKE_KEY);
      expect(text).not.toContain("f".repeat(40));
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("attacker.example");
    }
  });
});

describe("gateway origin boundary — ControlClient and PassControl agree", () => {
  // Accepted: bare origins only. The right-hand value is the *normalized* origin
  // each client must settle on — proof the accepted value is re-derived from the
  // parser rather than carried through by concatenation.
  it.each([
    ["https://gw.example.com", "https://gw.example.com"],
    ["https://gw.example.com/", "https://gw.example.com"], // trailing slash is the one tolerated shape
    ["https://gw.example.com:8443", "https://gw.example.com:8443"],
    ["https://gw.example.com:443", "https://gw.example.com"], // default port folded away
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:8788", "http://127.0.0.1:8788"],
    ["http://[::1]:3000", "http://[::1]:3000"],
    ["https://LOCALHOST", "https://localhost"], // the parser lowercases the host
    ["http://127.1", "http://127.0.0.1"], // shorthand IPv4 really is loopback
    ["http://[0:0:0:0:0:0:0:1]:3000", "http://[::1]:3000"], // expanded IPv6 loopback
  ])("accepts %s and normalizes it to %s", (gateway, origin) => {
    const outcome = constructBoth(gateway);
    expect(outcome.controlError).toBeUndefined();
    expect(outcome.passportError).toBeUndefined();
    expect(outcome.controlOrigin).toBe(origin);
    expect(outcome.passportOrigin).toBe(origin);
  });

  it.each([
    ["http://gateway.example"], // non-loopback HTTP — the reported finding
    ["HTTP://gateway.example"], // scheme case is the parser's business, not a prefix test
    ["http://192.168.1.10:3000"], // LAN
    ["http://10.0.0.5"], // LAN
    ["http://passcontrol:3000"], // Docker Compose service name
    ["http://host.docker.internal:3000"],
    ["http://localhost.example"], // lookalike: a hostname that merely starts with it
    ["http://notlocalhost"],
    ["http://localhost."], // trailing-dot lookalike
    ["http://127.0.0.1.attacker.example"], // lookalike: a suffix match would pass this
    ["http://[::2]:3000"], // not the loopback address
    ["/api/control/v1"], // relative
    ["//gw.example.com"], // protocol-relative
    ["gw.example.com"], // schemeless
    ["not a url"],
    ["https://trusted.example@attacker.example"], // deceptive userinfo
    ["https://admin:hunter2@gw.example.com"], // username + password
    ["https://gw.example.com/control"], // non-root path
    ["https://gw.example.com/api/control/v1/"], // trailing path segments
    ["https://gw.example.com//"], // not a bare origin either
    ["https://gw.example.com/?token=x"], // query
    ["https://gw.example.com/#frag"], // fragment
    ["ftp://gw.example.com"],
    ["javascript:alert(1)"], // parses as a URL; origin is null
    ["data:text/plain,hi"],
  ])("refuses %s in both clients, before any transport call", (gateway) => {
    const outcome = constructBoth(gateway);
    expect(outcome.controlError).toBeInstanceOf(Error);
    expect(outcome.passportError).toBeInstanceOf(Error);
    expect(outcome.controlError!.message).toMatch(/bare HTTPS origin|absolute URL/);
    expect(outcome.passportError!.message).toMatch(/bare HTTPS origin|absolute URL/);
    expect(outcome.controlOrigin).toBeUndefined();
    expect(outcome.reachedTransport).toBe(false);
  });

  it("still names its own client in the refusal, and still requires both fields", () => {
    expect(() => new ControlClient({ gateway: "http://gateway.example", apiKey: FAKE_KEY })).toThrow(
      "ControlClient: gateway must be a bare HTTPS origin (HTTP is allowed only for localhost)."
    );
    expect(() => new ControlClient({ gateway: "not a url", apiKey: FAKE_KEY })).toThrow(
      "ControlClient: gateway must be an absolute URL."
    );
    expect(() => new ControlClient({ gateway: "", apiKey: FAKE_KEY })).toThrow(
      "ControlClient: gateway and apiKey are required."
    );
    expect(() => new ControlClient({ gateway: "https://gw.example.com", apiKey: "" })).toThrow(
      "ControlClient: gateway and apiKey are required."
    );
  });
});

describe("ControlClient — nothing escapes /api/control/v1", () => {
  const PREFIX = "https://gw.example.com/api/control/v1/";

  it.each([
    ["..", (c: ControlClient) => c.agents.get("..")],
    ["../..", (c: ControlClient) => c.agents.get("../..")],
    ["%2e%2e", (c: ControlClient) => c.agents.get("%2e%2e")],
    ["/absolute", (c: ControlClient) => c.agents.get("/absolute")],
    ["https://attacker.example", (c: ControlClient) => c.agents.get("https://attacker.example")],
    ["..#?", (c: ControlClient) => c.agents.get("..#?")],
    ["suspend/..", (c: ControlClient) => c.agents.suspend("..")],
    ["revoke//..", (c: ControlClient) => c.agents.revoke("../../..")],
  ])("keeps a hostile id (%s) inside the control-plane prefix", async (_label, call) => {
    const { seen, fn } = captureTransport();
    const client = new ControlClient({
      gateway: "https://gw.example.com",
      apiKey: FAKE_KEY,
      fetch: fn as any,
    });
    await call(client);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.startsWith(PREFIX)).toBe(true);
    expect(new URL(seen[0]!.url).origin).toBe("https://gw.example.com");
  });

  it("percent-encodes query values instead of letting them add parameters", async () => {
    const { seen, fn } = captureTransport();
    const client = new ControlClient({
      gateway: "https://gw.example.com",
      apiKey: FAKE_KEY,
      fetch: fn as any,
    });
    await client.logs.list({ agent_id: "a&b=c#frag", status: "ok" });
    const url = new URL(seen[0]!.url);
    expect(url.searchParams.get("agent_id")).toBe("a&b=c#frag");
    expect([...url.searchParams.keys()]).toEqual(["agent_id", "status"]);
    expect(url.hash).toBe("");
    expect(seen[0]!.url).toContain("agent_id=a%26b%3Dc%23frag");
  });
});
