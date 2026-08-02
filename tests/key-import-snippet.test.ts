import { describe, expect, it } from "vitest";

// The shipped plain-ESM CLI is intentionally transpilation-free.
// @ts-expect-error JavaScript preset module has no TypeScript declaration file.
import { SIDECAR_PRESETS } from "@/cli/presets.mjs";
import { buildConfigureSnippet } from "@/app/dashboard/key-import-snippet";

const presets: string[] = SIDECAR_PRESETS;

const input = {
  passportId: "passport-public-id",
  passportSecret: "passport-private-secret",
  provider: "anthropic",
  model: "claude-sonnet-4'preview",
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
    expect(snippet).toContain("--model 'claude-sonnet-4'\\''preview'");
    expect(snippet.match(/passport-private-secret/g)).toHaveLength(1);
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
});
