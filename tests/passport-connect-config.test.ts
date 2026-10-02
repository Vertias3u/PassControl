import { describe, expect, it } from "vitest";

import { clientModelIsUsable, DEFAULT_ALLOWED_MODELS, DEFAULT_CLIENT_MODELS } from "@/lib/agent-connect";
import { buildPassportConnectSetup, passportIntegrationForProvider } from "@/lib/passport-connect-config";
import pkg from "@/package.json";

const common = {
  origin: "https://passcontrol.vertias.eu/",
  passportId: "public-id",
  passportSecret: "private-secret",
};

describe("Cloud Passport setup generation", () => {
  it("installs the current PassControl release rather than a stale literal", () => {
    const setup = buildPassportConnectSetup({ ...common, provider: "anthropic", model: "claude-haiku-4-5" });
    expect(setup.installCommand).toContain(`passcontrol@^${pkg.version}`);
    expect(setup.installCommand).not.toContain("0.6.0");
  });
  it("builds an Anthropic SDK setup with the secret only in the environment block", () => {
    const setup = buildPassportConnectSetup({ ...common, provider: "anthropic", model: "claude-haiku-4-5" });
    expect(setup.integration).toBe("anthropic-js");
    expect(setup.installCommand).toContain("@anthropic-ai/sdk");
    expect(setup.envBlock).toContain("PASSPORT_SECRET='private-secret'");
    expect(setup.clientCode).toContain('from "passcontrol/sdk"');
    expect(setup.clientCode).toContain('clientOptions("anthropic")');
    expect(setup.clientCode).not.toContain("private-secret");
    expect(setup.smokeCode).not.toContain("private-secret");
  });

  it.each(["openai", "groq", "mistral", "together", "deepseek"] as const)(
    "uses the OpenAI SDK shape for %s without putting the secret in source",
    (provider) => {
      const setup = buildPassportConnectSetup({ ...common, provider, model: DEFAULT_CLIENT_MODELS[provider] });
      expect(setup.integration).toBe("openai-js");
      expect(setup.clientCode).toContain(`clientOptions(\"${provider}\")`);
      expect(setup.clientCode).not.toContain("private-secret");
    }
  );

  it("keeps authorization patterns distinct from concrete runtime models", () => {
    expect(DEFAULT_ALLOWED_MODELS.anthropic).toContain("*");
    expect(clientModelIsUsable(DEFAULT_ALLOWED_MODELS.anthropic)).toBe(false);
    expect(clientModelIsUsable(DEFAULT_CLIENT_MODELS.anthropic)).toBe(true);
    expect(passportIntegrationForProvider("anthropic")).toBe("anthropic-js");
  });
});

// Any-API slice B: a passport agent that calls services and no model. Its
// worker reaches GitHub through the SDK's visa-refreshing fetch (proven with
// real Octokit through pc.fetch on the local stack, 2026-10-02), and the
// private key appears only in the env block.
describe("buildPassportServiceSetup", () => {
  it("wires Octokit through pc.fetch and keeps the secret in the env block only", async () => {
    const { buildPassportServiceSetup } = await import("@/lib/passport-connect-config");
    const setup = buildPassportServiceSetup({ origin: "https://gw.example/", passportId: "pid", passportSecret: "s3cr3t" });
    expect(setup.envBlock).toContain("export PASSPORT_SECRET='s3cr3t'");
    expect(setup.envBlock).not.toContain("PASSCONTROL_MODEL");
    expect(setup.installCommand).toMatch(/^npm install passcontrol@\^\S+ octokit$/);
    expect(setup.clientCode).toContain("request: { fetch: passcontrol.fetch }");
    expect(setup.clientCode).toContain("`${process.env.PASSCONTROL_GATEWAY}/api/v1/svc/github`");
    expect(setup.clientCode).toContain("/api/v1/svc/telegram/");
    expect(setup.clientCode).not.toContain("s3cr3t");
    expect(setup.sidecarCommands).toContain("passcontrol sidecar");
    expect(setup.sidecarCommands).toContain("passcontrol env github");
    expect(setup.sidecarCommands).toContain("http://127.0.0.1:8788/api/v1/svc/telegram/");
  });
});
