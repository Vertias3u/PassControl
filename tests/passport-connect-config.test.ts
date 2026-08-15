import { describe, expect, it } from "vitest";

import { clientModelIsUsable, DEFAULT_ALLOWED_MODELS, DEFAULT_CLIENT_MODELS } from "@/lib/agent-connect";
import { buildPassportConnectSetup, passportIntegrationForProvider } from "@/lib/passport-connect-config";

const common = {
  origin: "https://passcontrol.vertias.eu/",
  passportId: "public-id",
  passportSecret: "private-secret",
};

describe("Cloud Passport setup generation", () => {
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
