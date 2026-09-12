import { describe, expect, it } from "vitest";

// The shipped plain-ESM CLI is intentionally transpilation-free.
// @ts-expect-error JavaScript preset module has no TypeScript declaration file.
import { SIDECAR_PRESETS } from "@/cli/presets.mjs";
import { buildConfigureSnippet, buildPassportImportCommand } from "@/app/dashboard/key-import-snippet";

const presets: string[] = SIDECAR_PRESETS;

const input = {
  passportId: "passport-public-id",
  gateway: "https://passcontrol.example.com",
  provider: "anthropic",
  model: "claude-sonnet-4-preview",
};

describe("key-import configure handoff", () => {
  it.each(presets)("delegates the %s output to the existing configure preset", (integration) => {
    const snippet = buildConfigureSnippet({
      ...input,
      integration,
      allowedIntegrations: presets,
    });

    expect(snippet).toContain(`passcontrol configure ${integration}`);
    expect(snippet).toContain("--provider anthropic");
    expect(snippet).toContain("--model 'claude-sonnet-4-preview'");
    expect(snippet).toContain("passcontrol passport import --global");
    expect(snippet).toContain("--gateway 'https://passcontrol.example.com'");
    expect(snippet).toContain("--id 'passport-public-id'");
    expect(snippet).toContain("passcontrol sidecar");
    expect(snippet).not.toContain("PASSPORT_SECRET");
  });

  it("keeps the private key out of the public import command", () => {
    const command = buildPassportImportCommand({ gateway: input.gateway, passportId: input.passportId });
    expect(command).toContain(input.passportId);
    expect(command).not.toContain("secret");
  });

  it("refuses an integration outside the CLI-provided preset list", () => {
    expect(() =>
      buildConfigureSnippet({
        ...input,
        integration: "invented-preset",
        allowedIntegrations: presets,
      })
    ).toThrow("Unknown integration preset.");
  });

  it("refuses an authorization wildcard as a sidecar runtime model", () => {
    expect(() => buildConfigureSnippet({
      ...input,
      model: "claude-*",
      integration: "generic",
      allowedIntegrations: presets,
    })).toThrow("concrete model id");
  });
});
