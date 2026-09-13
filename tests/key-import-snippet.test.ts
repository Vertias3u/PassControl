import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
    expect(snippet).toContain("--model claude-sonnet-4-preview");
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
    expect(command).toContain("--gateway=https://passcontrol.example.com");
    expect(command).toContain("--id=passport-public-id");
  });

  // These two values used to be wrapped in POSIX single quotes. The dashboard
  // is a copy-to-clipboard button, and the shell on the other end of the paste
  // is not ours to choose: `cmd.exe` does not treat ' as quoting, so every
  // Windows operator who clicked "Copy import command" was handed a command
  // that could not work, and the CLI then refused a value that looked right on
  // the line in front of them. That is where this arrived from — a self-hoster
  // reporting "--gateway must be an absolute URL" against a command they never
  // typed. The fix is to emit values that need no shell to interpret at all.
  it("emits nothing that depends on a shell to unwrap it", () => {
    const command = buildPassportImportCommand({ gateway: input.gateway, passportId: input.passportId });
    const snippet = buildConfigureSnippet({ ...input, integration: "generic", allowedIntegrations: presets });
    for (const [label, text] of [["import", command], ["configure", snippet]] as const) {
      expect(text, label).not.toContain("'");
      expect(text, label).not.toContain('"');
      expect(text, label).not.toContain("\\");
    }
  });

  // Why `--id=` carries an `=` when `--provider` and `--model` do not.
  //
  // base64url's alphabet includes `-`, so roughly one passport in 4096 has an id
  // beginning `--`. The CLI's own parseArgv reads `--id VALUE` by taking the next
  // token only when it does not itself start with `--`, so a bare space-separated
  // id like that is swallowed as a flag name and the operator gets a usage error
  // naming neither cause nor value. Quoting never protected against this: the
  // shell strips the quotes before the CLI ever sees the token, so the POSIX form
  // had the same hole. `--id=` closes it on every platform at once.
  //
  // `--model` and `--provider` cannot hit it — clientModelIsUsable requires an
  // alphanumeric first character and isProvider is an enum — so they stay bare.
  it("survives a passport id that begins with two hyphens", () => {
    const command = buildPassportImportCommand({
      gateway: input.gateway,
      passportId: "--looks-like-a-flag-but-is-an-id",
    });
    expect(command).toContain("--id=--looks-like-a-flag-but-is-an-id");
  });

  it("refuses to build a command around a value a shell would reinterpret", () => {
    for (const passportId of ["id with space", "id;whoami", "id$(whoami)", "id&echo", "id|tee", "id`x`"]) {
      expect(
        () => buildPassportImportCommand({ gateway: input.gateway, passportId }),
        passportId,
      ).toThrow(/not safe to paste/);
    }
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

// The bug that started this was never visible from either side alone. The
// dashboard emitted a command it believed was quoted correctly, the CLI parsed
// argv it believed it had been handed correctly, and both were self-consistent.
// What nothing asserted was the JOIN: that a string this module produces still
// means the same thing after a real shell and a real parseArgv have had it.
//
// So this runs the generated command through the shipped binary. The id is
// well-formed base64url characters but the wrong length, which means success
// looks like the CLI's own "--id must be a 32-byte Ed25519" complaint — proof it
// PARSED the value — while the failure we are guarding against is a usage error,
// which is what a swallowed flag produces. It stops before any prompt or write.
describe("the generated command, through the shipped CLI", () => {
  const execFileAsync = promisify(execFile);
  const CLI = fileURLToPath(new URL("../bin/passcontrol.mjs", import.meta.url));

  const run = (command: string) => {
    const home = mkdtempSync(path.join(tmpdir(), "pc-snippet-"));
    const args = command.split(" ").slice(1);
    return execFileAsync(process.execPath, [CLI, ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        USERPROFILE: home,
        NO_COLOR: "1",
        NODE_ENV: "test",
        PASSCONTROL_FORCE_INSTALLED: "1",
      },
      timeout: 15000,
    }).catch((error) => error);
  };

  it("parses both values rather than mistaking either for a flag", async () => {
    const command = buildPassportImportCommand({
      gateway: "https://passcontrol.example.com",
      passportId: "--an-id-that-begins-like-a-flag",
    });
    const failure = await run(command);
    expect(failure.stderr).toMatch(/--id must be a 32-byte Ed25519/);
    expect(failure.stderr, "the id was swallowed as a flag name").not.toMatch(/Usage:/);
    expect(failure.stderr, "the gateway was rejected").not.toMatch(/absolute URL|bare HTTPS origin/);
  }, 20000);

  it("still parses an ordinary id, so the = form is not a special case", async () => {
    const command = buildPassportImportCommand({
      gateway: "https://passcontrol.example.com",
      passportId: "ordinary-looking-id",
    });
    const failure = await run(command);
    expect(failure.stderr).toMatch(/--id must be a 32-byte Ed25519/);
    expect(failure.stderr).not.toMatch(/Usage:/);
  }, 20000);
});

describe("key-import guards", () => {
  it("refuses an authorization wildcard as a sidecar runtime model", () => {
    expect(() => buildConfigureSnippet({
      ...input,
      model: "claude-*",
      integration: "generic",
      allowedIntegrations: presets,
    })).toThrow("concrete model id");
  });
});
