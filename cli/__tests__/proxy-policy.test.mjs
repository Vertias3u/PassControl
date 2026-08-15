import { describe, expect, it } from "vitest";

import {
  PROVIDER_UPSTREAMS,
  classifyConnect,
  classifyProxyRequest,
  isLoopbackBindHost,
  parseConnectTarget,
} from "../proxy-policy.mjs";

// The sidecar becomes a forward proxy in this change, which means it starts
// receiving destinations chosen by the CLIENT rather than by our config. That
// makes host classification a security decision, not a routing detail: get it
// wrong in one direction and PassControl silently carries an ungoverned provider
// call, get it wrong in the other and it is an open proxy on the user's laptop.

const GATEWAY = "https://passcontrol.example.com";

describe("parseConnectTarget", () => {
  it.each([
    ["api.anthropic.com:443", { hostname: "api.anthropic.com", port: 443 }],
    ["API.ANTHROPIC.COM:443", { hostname: "api.anthropic.com", port: 443 }],
    // A trailing dot is the fully-qualified spelling of the same name and
    // resolves identically. A naive string compare treats it as a different
    // host, which is a one-character bypass of the provider refusal.
    ["api.anthropic.com.:443", { hostname: "api.anthropic.com", port: 443 }],
    ["[::1]:8443", { hostname: "::1", port: 8443 }],
    ["127.0.0.1:3000", { hostname: "127.0.0.1", port: 3000 }],
  ])("parses %s", (raw, expected) => {
    expect(parseConnectTarget(raw)).toEqual(expected);
  });

  it.each(["api.anthropic.com", "", "   ", ":443", "host:0", "host:70000", "host:https", "a:1:2"])(
    "refuses the malformed target %j",
    (raw) => {
      expect(parseConnectTarget(raw)).toBeNull();
    }
  );
});

describe("classifyConnect", () => {
  const classify = (target, extra = {}) =>
    classifyConnect({ target, gatewayOrigin: GATEWAY, ...extra });

  it("refuses a provider host rather than tunnelling an ungoverned call", () => {
    const verdict = classify("api.anthropic.com:443");

    expect(verdict.allow).toBe(false);
    expect(verdict.code).toBe("provider_tunnel_not_governed");
    expect(verdict.status).toBe(403);
    // The refusal has to name the fix, not just the rule.
    expect(verdict.help).toMatch(/api\/v1\/anthropic/);
  });

  it.each(["api.openai.com", "api.groq.com", "api.mistral.ai", "api.together.ai", "api.deepseek.com"])(
    "refuses the provider host %s too",
    (host) => {
      expect(classify(`${host}:443`).code).toBe("provider_tunnel_not_governed");
    }
  );

  it("tunnels the configured gateway, which is where the visa was always going", () => {
    const verdict = classify("passcontrol.example.com:443");

    expect(verdict).toMatchObject({ allow: true, hostname: "passcontrol.example.com", port: 443 });
  });

  it("refuses the gateway host on a port the gateway does not serve", () => {
    expect(classify("passcontrol.example.com:8443").allow).toBe(false);
  });

  it("matches a loopback gateway on its explicit port", () => {
    const verdict = classify("127.0.0.1:3000", { gatewayOrigin: "http://127.0.0.1:3000" });

    expect(verdict.allow).toBe(true);
  });

  it("refuses an unrelated host — the sidecar is not an open proxy", () => {
    const verdict = classify("example.com:443");

    expect(verdict).toMatchObject({ allow: false, code: "host_not_allowed", status: 403 });
  });

  // Suffix matching is how allowlists die. `api.anthropic.com.attacker.example`
  // and `notpasscontrol.example.com` are other people's hostnames.
  it.each([
    "api.anthropic.com.attacker.example:443",
    "evil-api.anthropic.com:443",
    "notpasscontrol.example.com:443",
    "passcontrol.example.com.attacker.example:443",
  ])("refuses the look-alike host %s", (target) => {
    expect(classify(target).code).toBe("host_not_allowed");
  });

  it("tunnels a host the operator named explicitly", () => {
    expect(classify("example.com:443", { allowHosts: ["example.com"] }).allow).toBe(true);
  });

  it("honours a port-qualified allow entry exactly", () => {
    const allowHosts = ["example.com:8443"];

    expect(classify("example.com:8443", { allowHosts }).allow).toBe(true);
    expect(classify("example.com:443", { allowHosts }).allow).toBe(false);
  });

  // The allowlist exists to widen egress to a host the operator names. If it
  // could also name a provider it would stop being an egress control and become
  // an off-switch for governance, which is the one thing this component is for.
  it("never lets the allowlist re-enable an ungoverned provider tunnel", () => {
    const verdict = classify("api.anthropic.com:443", { allowHosts: ["api.anthropic.com"] });

    expect(verdict.allow).toBe(false);
    expect(verdict.code).toBe("provider_tunnel_not_governed");
  });

  it("refuses a malformed target with 400 rather than 403", () => {
    expect(classify("nonsense")).toMatchObject({ allow: false, code: "bad_connect_target", status: 400 });
  });
});

describe("classifyProxyRequest", () => {
  const classify = (url, extra = {}) => classifyProxyRequest({ url, gatewayOrigin: GATEWAY, ...extra });

  it("passes an origin-form path straight through", () => {
    expect(classify("/api/v1/anthropic/v1/messages")).toMatchObject({
      allow: true,
      path: "/api/v1/anthropic/v1/messages",
    });
  });

  // Absolute-form is what a client sends to a forward proxy. The sidecar used to
  // concatenate it onto the gateway origin verbatim, producing
  // `https://gateway/http://api.anthropic.com/v1/messages`.
  it("maps an absolute-form provider URL onto the governed gateway path", () => {
    expect(classify("http://api.anthropic.com/v1/messages")).toMatchObject({
      allow: true,
      path: "/api/v1/anthropic/v1/messages",
    });
  });

  it("strips the provider's own base path so groq does not double it", () => {
    expect(classify("http://api.groq.com/openai/v1/chat/completions")).toMatchObject({
      allow: true,
      path: "/api/v1/groq/v1/chat/completions",
    });
  });

  it("keeps the query string", () => {
    expect(classify("http://api.openai.com/v1/models?limit=2").path).toBe(
      "/api/v1/openai/v1/models?limit=2"
    );
  });

  it("passes an absolute-form gateway URL through as its own path", () => {
    expect(classify("https://passcontrol.example.com/api/v1/openai/v1/models")).toMatchObject({
      allow: true,
      path: "/api/v1/openai/v1/models",
    });
  });

  it("refuses an absolute-form URL for any other host", () => {
    expect(classify("http://example.com/anything")).toMatchObject({
      allow: false,
      code: "host_not_allowed",
      status: 403,
    });
  });

  it("refuses a request target that is neither origin-form nor absolute-form", () => {
    expect(classify("api.anthropic.com/v1/messages").allow).toBe(false);
  });
});

describe("isLoopbackBindHost", () => {
  it.each(["127.0.0.1", "127.1.1.1", "::1", "localhost", "LOCALHOST"])("accepts %s", (host) => {
    expect(isLoopbackBindHost(host)).toBe(true);
  });

  it.each(["0.0.0.0", "::", "192.168.1.10", "example.com", ""])("rejects %s", (host) => {
    expect(isLoopbackBindHost(host)).toBe(false);
  });
});

describe("PROVIDER_UPSTREAMS", () => {
  it("maps every provider to a distinct host", () => {
    const hosts = Object.values(PROVIDER_UPSTREAMS).map((entry) => entry.hostname);

    expect(new Set(hosts).size).toBe(hosts.length);
  });
});
