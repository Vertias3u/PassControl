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
    expect(snippet).toContain("passcontrol sidecar");
    expect(snippet).not.toContain("PASSPORT_SECRET");
    // The import is its own step in the UI. Carrying it here too handed the
    // operator the same command twice; see the count test below.
    expect(snippet).not.toContain("passcontrol passport import");
  });

  // The defect this pins was not in either builder — both were correct alone.
  // It was in the SEQUENCE the dashboard composes from them: step 2 renders
  // buildPassportImportCommand and step 3 rendered a snippet that began with the
  // same command, so the flow asked for one import twice and the second was
  // refused for want of --replace. Nothing asserted across the two, so nothing
  // caught it. This does, at the only level both are visible.
  it.each(presets)("asks for the %s passport import exactly once across the whole flow", (integration) => {
    const step2 = buildPassportImportCommand({ gateway: input.gateway, passportId: input.passportId });
    const step3 = buildConfigureSnippet({ ...input, integration, allowedIntegrations: presets });
    const flow = `${step2}\n${step3}`;

    const imports = flow.match(/passcontrol passport import/gu) ?? [];
    expect(imports).toHaveLength(1);
    // And the flow still gets the operator all the way to a running sidecar.
    expect(flow).toContain(`passcontrol configure ${integration}`);
    expect(flow).toContain("passcontrol sidecar");
  });

  it("keeps the private key out of the public import command", () => {
    const command = buildPassportImportCommand({ gateway: input.gateway, passportId: input.passportId });
    expect(command).toContain(input.passportId);
    expect(command).not.toContain("secret");
    // Both values are shell-quoted. These moved here from the configure-snippet
    // test when the import stopped being part of that snippet; the command is
    // where they were always actually asserted.
    expect(command).toContain("--gateway 'https://passcontrol.example.com'");
    expect(command).toContain("--id 'passport-public-id'");
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
