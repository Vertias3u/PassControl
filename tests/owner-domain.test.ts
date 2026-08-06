import { describe, it, expect, vi } from "vitest";

import {
  OWNER_WELL_KNOWN_PATH,
  isVerifiableDomain,
  newVerificationToken,
  verifyDomainControl,
} from "@/lib/owner/domain";

const TOKEN = "passcontrol-verify-abcdef0123456789";

function res(body: string, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: new Headers(),
  } as unknown as Response;
}

describe("which domains may be attempted", () => {
  it("accepts a bare hostname", () => {
    expect(isVerifiableDomain("acme.com")).toBe(true);
    expect(isVerifiableDomain("agents.acme.co.uk")).toBe(true);
  });

  // Everything below reaches the fetch as a URL. Since the edge runtime cannot
  // resolve DNS, private-IP blocklisting is impossible — so the input shape is
  // one of the two real controls (the other is never echoing the response).
  it.each([
    ["a scheme", "https://acme.com"],
    ["an explicit port", "acme.com:8080"],
    ["userinfo", "user@acme.com"],
    ["a path", "acme.com/admin"],
    ["a query", "acme.com?x=1"],
    ["an ipv4 literal", "169.254.169.254"],
    ["an ipv6 literal", "[::1]"],
    ["localhost", "localhost"],
    ["a trailing dot root", "."],
    ["whitespace", "acme .com"],
    ["empty", ""],
  ])("rejects %s", (_label, candidate) => {
    expect(isVerifiableDomain(candidate)).toBe(false);
  });

  it("rejects an absurdly long hostname", () => {
    expect(isVerifiableDomain(`${"a".repeat(300)}.com`)).toBe(false);
  });
});

describe("verifying control of a domain", () => {
  it("fetches the well-known document over https on that host", async () => {
    let requested = "";
    const fetchImpl = vi.fn(async (url: string) => {
      requested = String(url);
      return res(TOKEN);
    });

    const result = await verifyDomainControl("acme.com", TOKEN, { fetch: fetchImpl as never });

    expect(result.ok).toBe(true);
    expect(requested).toBe(`https://acme.com${OWNER_WELL_KNOWN_PATH}`);
  });

  // THE SSRF guard. Without redirect:"manual" a verifier is a general-purpose
  // request forwarder: point the well-known file at 169.254.169.254 and the
  // gateway fetches cloud instance metadata on the attacker's behalf. Following
  // no redirects is the control that works when you cannot resolve DNS.
  it("follows no redirects, and says so to fetch", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 302,
      text: async () => "",
      headers: new Headers({ location: "http://169.254.169.254/latest/meta-data/" }),
    })) as never;

    const result = await verifyDomainControl("acme.com", TOKEN, { fetch: fetchImpl });

    expect(result.ok).toBe(false);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      redirect: "manual",
    });
  });

  // The other half of accepting that private-IP blocklisting is impossible here:
  // whatever the fetch returns must never reach the caller. Otherwise a failed
  // verification becomes a read primitive against anything the gateway can reach.
  it("never echoes the fetched document back to the caller", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE-instance-credentials";
    const result = await verifyDomainControl("acme.com", TOKEN, {
      fetch: (async () => res(secret)) as never,
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("AKIA");
  });

  it("accepts the token on its own line among others", async () => {
    const body = `# PassControl ownership\n\n${TOKEN}\nsome-other-tool-token\n`;
    const result = await verifyDomainControl("acme.com", TOKEN, {
      fetch: (async () => res(body)) as never,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a token that merely appears as a substring", async () => {
    const result = await verifyDomainControl("acme.com", TOKEN, {
      fetch: (async () => res(`not-really-${TOKEN}-nope`)) as never,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a mismatched token", async () => {
    const result = await verifyDomainControl("acme.com", TOKEN, {
      fetch: (async () => res("some-other-token")) as never,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("token_mismatch");
  });

  it("rejects a non-200 response", async () => {
    const result = await verifyDomainControl("acme.com", TOKEN, {
      fetch: (async () => res(TOKEN, { status: 404 })) as never,
    });
    expect(result.ok).toBe(false);
  });

  it("reports an unreachable host without throwing", async () => {
    const result = await verifyDomainControl("acme.com", TOKEN, {
      fetch: (async () => {
        throw new Error("ENOTFOUND");
      }) as never,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("unreachable");
  });

  it("refuses a malformed domain before making any request", async () => {
    const fetchImpl = vi.fn();
    const result = await verifyDomainControl("http://acme.com", TOKEN, {
      fetch: fetchImpl as never,
    });

    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds how much of the document it will read", async () => {
    const huge = `${"x".repeat(64 * 1024)}\n${TOKEN}`;
    const result = await verifyDomainControl("acme.com", TOKEN, {
      fetch: (async () => res(huge)) as never,
    });
    // The token is past the read bound, so this must fail rather than stream
    // an unbounded response into memory looking for it.
    expect(result.ok).toBe(false);
  });
});

describe("verification tokens", () => {
  it("are unguessable and distinct", () => {
    const tokens = new Set(Array.from({ length: 32 }, () => newVerificationToken()));
    expect(tokens.size).toBe(32);
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(32);
  });

  it("are namespaced so a site owner can see what put them there", () => {
    expect(newVerificationToken()).toMatch(/^passcontrol-verify-/);
  });
});
