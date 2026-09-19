import { afterEach, describe, expect, it } from "vitest";

import {
  endpointPolicy,
  forwardableUpstreamSearch,
  isEndpointAllowed,
  joinUpstream,
  normalizeEndpoint,
} from "@/lib/providers/endpoint";

afterEach(() => {
  delete process.env.PROVIDER_ENDPOINT_MODE;
});

describe("the operator gate", () => {
  it("is off unless the operator turns it on", () => {
    expect(endpointPolicy()).toMatchObject({ kind: "off" });
    process.env.PROVIDER_ENDPOINT_MODE = "";
    expect(endpointPolicy()).toMatchObject({ kind: "off" });
    process.env.PROVIDER_ENDPOINT_MODE = "off";
    expect(endpointPolicy()).toMatchObject({ kind: "off" });
  });

  it("reads selfhost and an explicit host allowlist", () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    expect(endpointPolicy()).toMatchObject({ kind: "selfhost" });

    process.env.PROVIDER_ENDPOINT_MODE = "api.example.com, Proxy.Company.COM";
    expect(endpointPolicy()).toEqual({
      kind: "allowlist",
      hosts: ["api.example.com", "proxy.company.com"],
    });
  });

  // A value nobody meant must not become the permissive mode. `off` is the only
  // safe reading of a setting this build does not understand, and it is also the
  // reading that fails visibly — a refused endpoint is noticed, a silently
  // widened one is not.
  it("resolves an unparseable value to off, never to selfhost", () => {
    process.env.PROVIDER_ENDPOINT_MODE = "   ,  , ";
    expect(endpointPolicy()).toMatchObject({ kind: "off" });
  });
});

describe("what each mode admits", () => {
  const allowed = (url: string) => isEndpointAllowed(url, endpointPolicy());

  it("admits nothing at all while the gate is off", () => {
    expect(allowed("https://api.example.com/v1")).toBe(false);
  });

  describe("cloud allowlist", () => {
    const cloud = () => {
      process.env.PROVIDER_ENDPOINT_MODE = "gateway.company.com";
    };

    it("admits a named host over HTTPS", () => {
      cloud();
      expect(allowed("https://gateway.company.com/openai/v1")).toBe(true);
    });

    it.each([
      ["a host that is not on the list", "https://gateway.evil.com/v1"],
      ["a subdomain of a listed host", "https://a.gateway.company.com/v1"],
      ["plain HTTP", "http://gateway.company.com/v1"],
      ["a non-443 port", "https://gateway.company.com:8443/v1"],
      ["an IP literal", "https://10.0.0.5/v1"],
      ["loopback", "https://localhost/v1"],
    ])("refuses %s", (_label, url) => {
      cloud();
      expect(allowed(url)).toBe(false);
    });
  });

  describe("selfhost", () => {
    const selfhost = () => {
      process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    };

    // The whole reason this feature exists. Every one of these is refused by the
    // Cloud rules, and every one of them is the normal way somebody runs a local
    // model server.
    it.each([
      ["Ollama on loopback", "http://localhost:11434/v1"],
      ["Ollama by IP", "http://127.0.0.1:11434/v1"],
      ["vLLM on a private address", "http://10.1.2.3:8000/v1"],
      ["LiteLLM by internal hostname", "http://litellm.internal:4000/v1"],
      ["an internal host over HTTPS", "https://ai.corp.internal:8443/openai/v1"],
    ])("admits %s", (_label, url) => {
      selfhost();
      expect(allowed(url)).toBe(true);
    });

    // Structural validation still applies. These are not network-policy
    // questions — they are strings that have no business in a URL we build a
    // request from, whoever owns the gateway.
    it.each([
      ["credentials in the URL", "http://user:pass@10.1.2.3:8000/v1"],
      ["a non-HTTP scheme", "file:///etc/passwd"],
      ["a data URL", "data:text/plain,hi"],
      ["a query string", "http://10.1.2.3:8000/v1?key=leak"],
      ["a fragment", "http://10.1.2.3:8000/v1#x"],
      ["a control character", "http://10.1.2.3:8000/v1\nX-Injected: 1"],
      ["a parent segment", "http://10.1.2.3:8000/v1/../../admin"],
      ["nothing at all", ""],
      ["not a URL", "just some text"],
    ])("refuses %s even in selfhost", (_label, url) => {
      selfhost();
      expect(allowed(url)).toBe(false);
    });

    it("refuses an endpoint longer than any real one", () => {
      selfhost();
      expect(allowed(`http://10.1.2.3:8000/${"a".repeat(2048)}`)).toBe(false);
    });
  });
});

describe("normalising what gets stored", () => {
  it("keeps the base path and drops a trailing slash", () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    expect(normalizeEndpoint("http://10.1.2.3:8000/openai/v1/")).toBe(
      "http://10.1.2.3:8000/openai/v1"
    );
    expect(normalizeEndpoint("HTTP://10.1.2.3:8000/v1")).toBe("http://10.1.2.3:8000/v1");
  });

  it("returns null for anything it would not admit", () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    expect(normalizeEndpoint("http://10.1.2.3:8000/v1?k=1")).toBeNull();
  });
});

/**
 * One canonical join, because `new URL` has three different answers here and two
 * of them silently discard part of the operator's base path:
 *
 *   new URL("/chat", "https://h/openai/v1/")  -> https://h/chat
 *   new URL("chat",  "https://h/openai/v1")   -> https://h/openai/chat
 *   new URL("chat",  "https://h/openai/v1/")  -> https://h/openai/v1/chat
 *
 * A gateway that quietly drops `/openai/v1` sends a credential to a path the
 * operator did not name, so this never uses `new URL` for the join.
 */
describe("joining an upstream path onto a base", () => {
  it.each([
    ["https://h/v1", "https://h/v1/chat/completions"],
    ["https://h/v1/", "https://h/v1/chat/completions"],
    ["https://h", "https://h/chat/completions"],
    ["https://h/", "https://h/chat/completions"],
    ["https://h/proxy/openai/v1", "https://h/proxy/openai/v1/chat/completions"],
    ["http://10.1.2.3:8000/v1", "http://10.1.2.3:8000/v1/chat/completions"],
  ])("preserves the whole base path of %s", (base, expected) => {
    expect(joinUpstream(base, ["chat", "completions"])).toBe(expected);
  });

  it("never collapses a double slash into a changed path", () => {
    expect(joinUpstream("https://h/v1//", ["chat"])).toBe("https://h/v1/chat");
  });

  it("refuses to join a traversal segment", () => {
    expect(() => joinUpstream("https://h/v1", ["..", "admin"])).toThrow();
    expect(() => joinUpstream("https://h/v1", ["a", ".", "b"])).toThrow();
  });

  it("refuses a segment carrying its own separator or control characters", () => {
    expect(() => joinUpstream("https://h/v1", ["chat/../admin"])).toThrow();
    expect(() => joinUpstream("https://h/v1", ["chat\ncompletions"])).toThrow();
  });

  it("leaves an already-encoded segment exactly as the client sent it", () => {
    expect(joinUpstream("https://h/v1", ["models", "meta%2Fllama-3"])).toBe(
      "https://h/v1/models/meta%2Fllama-3"
    );
  });
});

/**
 * The framework's routing parameters are not the client's query string.
 *
 * Next hands `[provider]` and `[...path]` to the handler in `req.url`'s SEARCH
 * as well as in `ctx.params` — it re-appends them as ordinary parameters after
 * stripping its own `nxtP` prefix. Forwarded verbatim, that put
 * `?provider=openai&path=v1&path=chat&path=completions` on a request carrying a
 * provider key, and OpenAI answered "Duplicate parameter: 'path'".
 *
 * These cases are written against the URL shape a running Next server was
 * OBSERVED to produce, because a test that builds a tidy URL passes whether or
 * not the bug is fixed.
 */
describe("the query string forwarded upstream", () => {
  const ROUTE_PARAMS = ["provider", "path"];

  it("drops the routing parameters Next injects into req.url", () => {
    expect(
      forwardableUpstreamSearch(
        "https://gw.test/api/v1/openai/v1/chat/completions?provider=openai&path=v1&path=chat&path=completions",
        ROUTE_PARAMS
      )
    ).toBe("");
  });

  it("keeps a real client parameter that sits among them", () => {
    // Anthropic's model listing pages with `limit` / `after_id`, and Next
    // interleaves its own parameters around whatever the caller sent.
    expect(
      forwardableUpstreamSearch(
        "https://gw.test/api/v1/anthropic/v1/models?limit=5&path=v1&path=models&after_id=m_1&provider=anthropic",
        ROUTE_PARAMS
      )
    ).toBe("?limit=5&after_id=m_1");
  });

  it("forwards a client parameter byte for byte, encoding intact", () => {
    // Re-encoding a query the caller built is not this function's job; the only
    // thing it is allowed to do is remove.
    expect(
      forwardableUpstreamSearch("https://gw.test/x?after_id=a%2Cb%20c", ROUTE_PARAMS)
    ).toBe("?after_id=a%2Cb%20c");
  });

  it("returns nothing at all when the client sent no query", () => {
    expect(forwardableUpstreamSearch("https://gw.test/api/v1/openai/v1/chat/completions", [])).toBe("");
  });

  it("drops a routing parameter smuggled in percent-encoded", () => {
    // `pa%74h` decodes to `path`. Compared after decoding, so a caller cannot
    // spell its way past the filter.
    expect(forwardableUpstreamSearch("https://gw.test/x?pa%74h=evil", ROUTE_PARAMS)).toBe("");
  });

  it("drops a key it cannot decode rather than forwarding it with a credential", () => {
    // Undecodable means uncheckable. Every allowlisted endpoint treats its query
    // as optional, so refusing to carry it is always the safe answer.
    expect(forwardableUpstreamSearch("https://gw.test/x?%E0%A4%A=1&limit=2", ROUTE_PARAMS)).toBe(
      "?limit=2"
    );
  });

  it("drops the framework's own prefixed parameters if one ever survives", () => {
    // Nothing prefixed reaches a handler today — the adapter normalises them
    // first. The day one does, it must not reach a provider either.
    expect(
      forwardableUpstreamSearch("https://gw.test/x?nxtPpath=v1&nxtIfoo=1&limit=2", ROUTE_PARAMS)
    ).toBe("?limit=2");
  });

  it("takes the names from the route, so a renamed segment cannot leave a stale one", () => {
    // `provider` is only special because THIS route calls a segment that. Asked
    // of the params object, never written down twice.
    expect(forwardableUpstreamSearch("https://gw.test/x?provider=openai", [])).toBe(
      "?provider=openai"
    );
    expect(forwardableUpstreamSearch("https://gw.test/x?tenant=acme", ["tenant"])).toBe("");
  });
});
