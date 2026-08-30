import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// What a self-hoster's Control Tower must and must not contain, asserted by running
// the same marker transform scripts/curate-public.sh runs. The private tree is not
// the tree this is about: every leak here was invisible privately, because privately
// the hosted branding and the hosted allowance are correct.
//
// The marker tokens are assembled from fragments, never spelled out — this file ships,
// and curation edits any line carrying one. See the sibling guard,
// scripts/__tests__/curate-markers-are-comments.test.mjs.
const MARK = "curate:";
const PRIVATE_START = `${MARK}private-start`;
const PRIVATE_END = `${MARK}private-end`;
const PUBLIC_ONLY_START = `${MARK}public-only-start`;
const PUBLIC_ONLY_END = `${MARK}public-only-end`;

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/** The strip-then-reveal the curation script applies, in the same order. */
function curated(path: string): string {
  const input = source(path);
  const withoutPrivate = input.replace(
    new RegExp(`^[^\\n]*${PRIVATE_START}.*?${PRIVATE_END}[^\\n]*\\n`, "gms"),
    ""
  );
  const output: string[] = [];
  let insidePublicOnly = false;
  for (const line of withoutPrivate.split("\n")) {
    if (line.includes(PUBLIC_ONLY_START)) {
      insidePublicOnly = true;
      continue;
    }
    if (line.includes(PUBLIC_ONLY_END)) {
      insidePublicOnly = false;
      continue;
    }
    output.push(insidePublicOnly ? line.replace(/^(\s*)\/\/ ?/u, "$1") : line);
  }
  return output.join("\n");
}

describe("Core dashboard boundary", () => {
  it("carries no company mark on any chrome the mirror ships", () => {
    const brand = curated("components/SiteBrand.tsx");

    expect(brand).not.toMatch(/Vertias/);
    expect(brand).toContain("ShieldCheck");
    expect(brand).toContain("PassControl");
    // Both exports must survive the transform, or every chrome in the tree fails
    // to compile on a name the private tree still resolves.
    expect(brand).toContain("export function SiteLogo");
    expect(brand).toContain("export function SiteWordmark");
  });

  it("routes every chrome through the one marked module", () => {
    // Eleven call sites. A per-file marker would be eleven chances to miss one,
    // and the one missed is whichever page the reader opens first — /login, as it
    // happens, since /dashboard redirects there.
    for (const path of [
      "components/auth/AuthShell.tsx",
      "components/dashboard/DashboardBrand.tsx",
      "app/not-found.tsx",
      "app/verify/page.tsx",
      "app/verify/receipt/page.tsx",
      "app/u/[handle]/page.tsx",
    ]) {
      expect(source(path), path).toContain('@/components/SiteBrand');
      expect(source(path), path).not.toMatch(/Vertias(Logo|Wordmark)/);
    }

    for (const path of [
      "components/dashboard/DashboardShell.tsx",
      "components/dashboard/DashboardSkeleton.tsx",
      "components/dashboard/ControlGraph.tsx",
    ]) {
      expect(source(path), path).toContain("<DashboardBrand");
    }
  });


  it("replaces the hosted allowance with one optional Cloud card in Core", () => {
    const panel = curated("components/dashboard/OperationsPanel.tsx");
    const page = curated("app/dashboard/page.tsx");

    expect(page).not.toContain("readCloudBetaQuotaSnapshot");
    expect(page).toContain("Promise.resolve(null)");
    expect(page).toContain("<OperationsPanel");

    // The hosted allowance implementation is absent. Core uses the same slot
    // for one optional hosted alternative, without putting it in chrome.
    expect(panel).toContain("function allowanceCard(quota: OperationsQuota)");
    expect(panel).toContain("return noQuotaCard()");
    // Named symbols, not the bare word: `noQuotaCard` — Core's own slot, asserted
    // on the line above — contains "QuotaCard", so a substring ban can never pass.
    // These three are what the hosted card actually is: the component, its call
    // site, and the Cloud type it reads.
    expect(panel).not.toContain("function QuotaCard(");
    expect(panel).not.toContain("<QuotaCard");
    expect(panel).not.toContain("CloudBetaQuotaSnapshot");
    expect(panel).toContain('href="https://passcontrol.vertias.eu/beta"');
    expect(panel.match(/https:\/\/passcontrol\.vertias\.eu/g)).toHaveLength(1);
    expect(panel).toContain("invite-only");
    expect(panel).toContain("operates Postgres, Redis, and migrations");
    expect(panel).toContain("permanent public issuer");
    expect(panel).toContain('return "Instance operations"');
    expect(panel).not.toContain("Cloud beta appendix");
    expect(panel).toContain("Deployment signals");
    expect(panel).toContain("Download redacted bundle");
  });


  it("gives a self-hoster one accent and no control over it", () => {
    // The accent theme is a Cloud differentiator by decision
    // (plans/cloud-accent-theme.md). Core renders --pc-brand straight from
    // globals.css, so nothing here may reach for a cookie or a picker.
    const settings = curated("app/dashboard/settings/page.tsx");
    const layout = curated("app/layout.tsx");
    const shell = curated("components/dashboard/DashboardShell.tsx");

    for (const token of ["AccentThemePicker", "cloud-theme", "ACCENT_COOKIE", "readAccent"]) {
      expect(settings, token).not.toContain(token);
      expect(layout, token).not.toContain(token);
      expect(shell, token).not.toContain(token);
    }
    // The shell is where the accent is applied, so it is where the strip has to
    // land cleanly — its root div must survive with its classes intact.
    expect(shell).toContain('className="pc-app min-h-screen bg-background text-foreground"');
    expect(shell).not.toContain("accentVars");
    // Comments survive curation. A Cloud-only route named in one ships to the
    // mirror as documentation of a page that does not exist there, and curation's
    // own pruned-module check does not see it: that check matches DIRECTORY refs
    // (the app/ prefix plus a trailing slash) while a comment writes the ROUTE, a
    // leading slash and no trailing one. Different string, same leak. It has now
    // bitten three times — once naming the Cloud theme module, then in both files
    // below naming three pruned routes.
    //
    // The route names are assembled rather than written out for the same reason
    // the marker tokens at the top of this file are: this file ships, and spelling
    // one of them next to the app/ prefix trips the very check described above.
    for (const cloudRoute of ["learn", "updates", "legal"]) {
      const route = `/${cloudRoute}`;
      expect(shell, route).not.toContain(route);
      expect(layout, route).not.toContain(route);
      expect(settings, route).not.toContain(route);
    }
    expect(settings).not.toContain('id="appearance"');
    // The strip must not take the surrounding element with it: the layout still
    // has to render an <html> with the font classes on it, or the mirror ships a
    // page that cannot mount. A colour guard would not catch that; this does.
    expect(layout).toContain("<html");
    expect(layout).toContain("plexMono.variable");
    expect(settings).toContain('id="provider-credentials"');
  });

  it("documents only refusals a self-hosted gateway can actually emit", () => {
    const operations = curated("lib/cloud-operations.ts");

    // Assembled from fragments for the same reason the marker tokens above are:
    // this file ships, and curate-public.sh greps the curated tree for these two
    // refusal codes to prove the pruned quota module left nothing behind. Spelled
    // out, this guard would trip that check on itself. Fragmented, the check stays
    // alive in the mirror instead of being marked private and lost there.
    for (const hostedOnly of [["beta_quota", "exceeded"], ["quota", "unavailable"]]) {
      expect(operations).not.toContain(hostedOnly.join("_"));
    }
    for (const core of ["rate_limited", "blocked_budget", "blocked_suspended", "blocked_killed"]) {
      expect(operations).toContain(core);
    }
  });

  it("does not tell a self-hoster their calls route through our service", () => {
    const activation = curated("components/dashboard/FirstCallActivation.tsx");

    expect(activation).not.toContain("goes through PassControl Cloud");
    expect(activation).toContain("goes through this PassControl gateway");
    // One return per branch after the transform, not two.
    expect(activation.match(/goes through this PassControl gateway/g)).toHaveLength(2);
  });
});
