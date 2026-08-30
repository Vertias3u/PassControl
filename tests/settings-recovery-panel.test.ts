import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

async function recoveryNoticeSource(): Promise<string> {
  for (const path of [
    "app/notices/recovery/page.selfhost.tsx",
    "app/notices/recovery/page.tsx",
  ]) {
    try {
      return await source(path);
    } catch {
      // The private tree has the inactive source; curation activates page.tsx.
    }
  }
  throw new Error("self-host recovery notice is missing");
}

describe("settings — recovery panel", () => {
  it("is mounted on the settings page with a nav entry", async () => {
    const page = await source("app/dashboard/settings/page.tsx");
    expect(page).toContain("<RecoveryPanel");
    expect(page).toContain('href="#recovery"');
    expect(page).toContain('id="recovery"');
    // The nav mirrors DOM order, so the destructive account-data section must
    // stay above the new one rather than being pushed down the page.
    expect(page.indexOf('id="account-data"')).toBeLessThan(page.indexOf('id="recovery"'));
  });

  it("reads the last export from the audit trail", async () => {
    const page = await source("app/dashboard/settings/page.tsx");
    expect(page).toContain('.eq("action", "workspace.export")');
  });

  it("points at the export route and the public recovery notice", async () => {
    const panel = await source("components/RecoveryPanel.tsx");
    expect(panel).toContain('href="/api/workspace/export"');
    expect(panel).toContain("href={recoveryNoticeHref()}");
  });

  // ── The honesty pins ──────────────────────────────────────────────────────
  // This panel is read by someone deciding whether they are covered. It must
  // not claim a safety net the product cannot see. The wording was chosen
  // deliberately over the mock's "Managed by Supabase plan", which is true on a
  // paid plan and misleading on the free tier — and these assertions are how
  // that decision survives a future copy edit by someone who wasn't here.
  it("does not claim a backup arrangement it cannot verify", async () => {
    const panel = await source("components/RecoveryPanel.tsx");
    expect(panel).not.toMatch(/managed by supabase/i);
    expect(panel).toMatch(/cannot see whether/i);
  });

  // Learned from a real round trip, not from the schema: agents.passport_pubkey
  // is UNIQUE globally rather than per tenant, so a file imported back into the
  // instance it came from creates nothing. The page has to say that, or an
  // operator rehearsing a restore reads the empty result as a broken import.
  it("says a restore goes into a fresh instance, and why", async () => {
    const notice = await recoveryNoticeSource();
    expect(notice).toMatch(/one agent per instance/i);
    expect(notice).toMatch(/fresh/i);
  });

  it("states the provider-key re-entry limit rather than burying it", async () => {
    const panel = await source("components/RecoveryPanel.tsx");
    expect(panel).toMatch(/re-entered by hand/i);
    expect(panel).toMatch(/no export and no backup/i);
  });
});
