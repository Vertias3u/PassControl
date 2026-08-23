import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { WORKSPACE_EXPORT_SCHEMA_VERSION } from "@/lib/workspace-export";
// @ts-expect-error — plain .mjs CLI module, no types
import { WORKSPACE_IMPORT_MAX_VERSION } from "../cli/config.mjs";
// @ts-expect-error — plain .mjs CLI module, no types
import { importCompletionMessage, noAgentCreateMessage } from "../cli/workspace-import-report.mjs";

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

// PUBLIC_README.md is renamed to README.md by scripts/curate-public.sh, so the
// private name does not exist in the public mirror — where this test also
// ships, and where it threw ENOENT rather than asserting anything.
// tests/docs-integrations.test.ts already carries this fallback for the same
// reason; this one was written without it.
async function readme(): Promise<string> {
  for (const candidate of ["PUBLIC_README.md", "README.md"]) {
    try {
      return await source(candidate);
    } catch {
      continue;
    }
  }
  throw new Error("neither PUBLIC_README.md nor README.md exists — this guard is reading nothing");
}

describe("passcontrol export / import", () => {
  // The CLI ships standalone and cannot import from lib/, so the schema version
  // exists twice. Imported here rather than grepped, so this fails on the values
  // rather than on how they happen to be written.
  it("keeps the CLI's accepted schema version level with the exporter's", () => {
    expect(WORKSPACE_IMPORT_MAX_VERSION).toBe(WORKSPACE_EXPORT_SCHEMA_VERSION);
  });

  it("registers both commands in the dispatch and the usage text", async () => {
    const cli = await source("bin/passcontrol.mjs");
    expect(cli).toContain('case "export":');
    expect(cli).toContain('case "import":');
    // usage() drifting from the dispatch is a documented past failure in this
    // CLI, so the help text is asserted, not assumed.
    expect(cli).toContain("${cmd} export");
    expect(cli).toContain("${cmd} import <file>");
  });

  // Writing is gated behind an explicit literal, matching `reset --confirm RESET`.
  it("previews before it writes, and will not write without --confirm IMPORT", async () => {
    const cli = await source("bin/passcontrol.mjs");
    expect(cli).toContain("dry_run=true");
    expect(cli).toContain('opts.confirm !== "IMPORT"');
    const preview = cli.indexOf("dry_run=true");
    const confirm = cli.indexOf('opts.confirm !== "IMPORT"');
    expect(preview, "the dry run must run before the confirmation gate").toBeLessThan(confirm);
  });

  // The 64 KiB cap in lib/control/body.ts is shared by every control-plane
  // route and is deliberately not raised for the import, so the CLI has to
  // explain the limit instead of letting the server return a bare 413.
  it("checks the payload against the shared body cap before sending", async () => {
    const cli = await source("bin/passcontrol.mjs");
    expect(cli).toContain("IMPORT_BODY_LIMIT");
    expect(cli).toMatch(/import them one at a time/i);
  });

  it("sends only the two things an import writes", async () => {
    const cli = await source("bin/passcontrol.mjs");
    expect(cli).toContain("const payload = { agents, ownership:");
    // Sending a credential list the server ignores would spend the size budget
    // on bytes that cannot be restored.
    expect(cli).not.toContain("providerMappings,");
  });

  // PUBLIC_README's capability table enumerates what the CLI can do, so a new
  // command that is not in it does not merely go unmentioned — the table reads
  // as complete and is then wrong. This CLI has drifted its own usage text
  // before, which is why cli/presets.mjs generates the integration list.
  it("is listed in the public capability table", async () => {
    const text = await readme();
    expect(text).toContain("passcontrol export");
    expect(text).toContain("passcontrol import");
  });

  it("refuses a file from a newer schema rather than dropping fields", async () => {
    const cli = await source("bin/passcontrol.mjs");
    expect(cli).toContain("WORKSPACE_IMPORT_MAX_VERSION");
    expect(cli).toMatch(/passcontrol-export/);
  });

  it("does not call an all-refused import an already-restored workspace", () => {
    expect(noAgentCreateMessage({ skipped: [], rejected: [{ name: "billing", reason: "passport_registered_elsewhere" }] }))
      .toMatch(/were refused/i);
    expect(noAgentCreateMessage({ skipped: ["billing"], rejected: [] }))
      .toMatch(/already holds every agent/i);
    expect(importCompletionMessage({ complete: false, agents: { created: ["billing"] } }))
      .toMatch(/completed partially/i);
  });
});
