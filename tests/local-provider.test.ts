// Local models (1.2.0): the `local` provider's rules, below the proxy.
//
// `local` is an OpenAI-compatible server the developer runs themselves (Ollama,
// LM Studio, vLLM). It has no host of ours, so its address is part of the
// credential, like Azure's. Unlike Azure, nothing admits that address except
// the operator gate: off (hosted Cloud's default) refuses every local address.
import { describe, expect, it } from "vitest";

import {
  LOCAL_NO_KEY,
  authHeaders,
  providerRequiresEndpoint,
  requestShapeFamily,
  upstreamBaseUrl,
} from "@/lib/providers";
import { isEndpointAllowedFor, normalizeEndpointFor } from "@/lib/providers/endpoint";
import { validateProviderKeyInput } from "@/lib/validate";

const OLLAMA = "http://localhost:11434/v1";

describe("the local provider", () => {
  it("has no built-in host, so its address must come with the credential", () => {
    expect(upstreamBaseUrl("local")).toBeNull();
    expect(providerRequiresEndpoint("local")).toBe(true);
    expect(requestShapeFamily("local")).toBe("openai");
  });

  it("sends a real key as a bearer token, and nothing for a keyless server", () => {
    expect(authHeaders("local", "vllm-secret")).toEqual({ authorization: "Bearer vllm-secret" });
    expect(authHeaders("local", LOCAL_NO_KEY)).toEqual({});
  });

  it("never treats the keyless marker as a key for any other provider", () => {
    expect(authHeaders("openai", LOCAL_NO_KEY)).toEqual({ authorization: `Bearer ${LOCAL_NO_KEY}` });
  });
});

describe("where a local credential may be sent", () => {
  it("is nowhere when the operator gate is off", () => {
    expect(isEndpointAllowedFor("local", OLLAMA, { kind: "off" })).toBe(false);
    expect(normalizeEndpointFor("local", OLLAMA, { kind: "off" })).toBeNull();
    expect(isEndpointAllowedFor("local", "https://models.example.com/v1", { kind: "off" })).toBe(false);
  });

  it("is any structurally valid address in selfhost mode", () => {
    expect(isEndpointAllowedFor("local", OLLAMA, { kind: "selfhost" })).toBe(true);
    expect(normalizeEndpointFor("local", `${OLLAMA}/`, { kind: "selfhost" })).toBe(OLLAMA);
    expect(isEndpointAllowedFor("local", "http://10.0.0.5:8000/v1", { kind: "selfhost" })).toBe(true);
  });

  it("keeps the structural checks in selfhost mode", () => {
    expect(isEndpointAllowedFor("local", "http://user:pw@localhost:11434/v1", { kind: "selfhost" })).toBe(false);
    expect(isEndpointAllowedFor("local", "http://localhost:11434/v1/../admin", { kind: "selfhost" })).toBe(false);
    expect(isEndpointAllowedFor("local", "file:///etc/passwd", { kind: "selfhost" })).toBe(false);
  });

  it("is only a listed host under an allowlist", () => {
    const policy = { kind: "allowlist" as const, hosts: ["models.example.com"] };
    expect(isEndpointAllowedFor("local", "https://models.example.com/v1", policy)).toBe(true);
    expect(isEndpointAllowedFor("local", OLLAMA, policy)).toBe(false);
  });

  it("leaves Azure's own rule alone", () => {
    expect(isEndpointAllowedFor("azure", OLLAMA, { kind: "selfhost" })).toBe(false);
  });
});

describe("storing a local credential", () => {
  it("accepts no key, storing the keyless marker", () => {
    expect(validateProviderKeyInput({ provider: "local", label: "ollama", key: "" })).toEqual({
      provider: "local",
      label: "ollama",
      key: LOCAL_NO_KEY,
    });
  });

  it("keeps a key that was given", () => {
    expect(validateProviderKeyInput({ provider: "local", label: "vllm", key: "secret" }).key).toBe("secret");
  });

  it("still requires a key for every other provider", () => {
    expect(() => validateProviderKeyInput({ provider: "openai", label: "x", key: "" })).toThrow();
  });
});

describe("which providers a chooser offers", () => {
  it("leaves local out where the gate is off, and keeps every other provider", async () => {
    const { PROVIDERS, offeredProviders } = await import("@/lib/providers");
    const offered = offeredProviders(PROVIDERS, false);
    expect(offered).not.toContain("local");
    expect(offered).toEqual(PROVIDERS.filter((p) => p !== "local"));
  });

  it("offers local where the gate is open", async () => {
    const { PROVIDERS, offeredProviders } = await import("@/lib/providers");
    expect(offeredProviders(PROVIDERS, true)).toContain("local");
  });

  it("keeps a saved local value even where the gate is off, so it is never shown as another provider", async () => {
    const { SCOPE_PROVIDERS, offeredProviders } = await import("@/lib/providers");
    expect(offeredProviders(SCOPE_PROVIDERS, false, ["local"])).toContain("local");
  });
});
