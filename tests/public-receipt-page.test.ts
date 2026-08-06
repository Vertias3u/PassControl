// The routing and indexing side of the public receipt page. The verification
// logic is covered by tests/sdk-verify-trace.test.ts and tests/receipt-view.test.ts;
// this pins the things that live outside them and fail silently when wrong.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRERENDERED_PUBLIC_PATHS, isPrerenderedPublicPath, needsExternalJwks } from "@/lib/csp";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

const repo = process.cwd();
const read = (path: string) => readFileSync(join(repo, path), "utf8");

const page = read("app/verify/receipt/page.tsx");
const component = read("components/ReceiptVerifier.tsx");
const middleware = read("middleware.ts");
const css = read("app/globals.css");

describe("the route is reachable by a stranger", () => {
  it("is covered by /verify in PUBLIC_PATHS, so no session is required", () => {
    const publicPaths = middleware.match(/const PUBLIC_PATHS = \[([\s\S]*?)\]/)?.[1] ?? "";
    expect(publicPaths).toContain('"/verify"');
    // isPublic() matches on the prefix, so /verify covers /verify/receipt.
    expect(publicPaths).toContain('"/verify"');
  });

  // This is the one public page in the app that ships JavaScript. Prerendering
  // it would mean its scripts were emitted at build time with no nonce to
  // carry, which under 'strict-dynamic' means it never hydrates — so the
  // fallback would be 'unsafe-inline' on an anonymous page. Dynamic instead.
  it("is dynamically rendered so it carries a nonce rather than unsafe-inline", () => {
    expect(page).toMatch(/export const dynamic = "force-dynamic"/);
    expect(PRERENDERED_PUBLIC_PATHS).not.toContain("/verify/receipt");
    expect(isPrerenderedPublicPath("/verify/receipt")).toBe(false);
  });

  it("is the only route allowed to fetch an external key set", () => {
    expect(needsExternalJwks("/verify/receipt")).toBe(true);
    expect(needsExternalJwks("/verify")).toBe(false);
  });
});

describe("indexing", () => {
  // Unlike /verify/<passport-id>, nothing private can appear in this URL — it is
  // a paste box, not a per-record page — so it is a legitimate landing page for
  // someone who has been handed a receipt and is searching for how to check it.
  it("is carved back out of the /verify/ disallow", () => {
    const rule = [robots().rules].flat()[0]!;
    expect([rule.allow].flat()).toContain("/verify/receipt");
    expect([rule.disallow].flat()).toContain("/verify/");
  });

  it("keeps per-passport pages out of the index", () => {
    const rule = [robots().rules].flat()[0]!;
    expect([rule.allow].flat()).not.toContain("/verify/");
    for (const path of ["/dashboard", "/api/"]) {
      expect([rule.disallow].flat()).toContain(path);
    }
  });

  it("declares itself indexable in its own metadata, agreeing with robots.txt", () => {
    // A page that robots.txt allows but that sets index:false is a silent
    // contradiction — the crawler fetches it and then throws it away.
    expect(page).toMatch(/robots:\s*\{\s*index:\s*true/);
  });

  it("is listed in the sitemap", () => {
    expect(sitemap().map((entry) => entry.url)).toContain(
      "https://passcontrol.vertias.eu/verify/receipt"
    );
  });
});

describe("the verifier runs where it claims to", () => {
  it("is a client component", () => {
    expect(component.startsWith('"use client"')).toBe(true);
  });

  // The entire promise of the page. If verification ever moves server-side, the
  // page would have to stop saying the receipt is never sent to Vertias — and
  // a server in the trust path could serve a key that makes a forgery pass.
  it("imports the same published verifier a third party would run", () => {
    expect(component).toMatch(/from "@\/sdk\/verify"/);
    expect(component).toContain("verifyReceipt");
  });

  it("never posts the receipt anywhere", () => {
    expect(component).not.toMatch(/method:\s*["']POST["']/);
    expect(component).not.toMatch(/fetch\(\s*["'`]\/api\//);
  });

  it("settles everything it can locally before reaching the network", () => {
    // preflight() covers the issuer guard among other things: `iss` is read from
    // an UNVERIFIED payload, so until the signature says otherwise it is a
    // string the receipt's author controls, and it is validated before anything
    // is handed to fetch(). tests/receipt-view.test.ts proves preflight agrees
    // with the real verifier about where each input fails.
    expect(component).toContain("preflight(trimmed)");
  });

  it("trusts the issuer the receipt names, which is what self-hosters need", () => {
    expect(component).toMatch(/trustedIssuers:\s*\[issuer\]/);
  });

  // A page stuck on "Checking…" with no way back is a worse failure than any
  // verdict it could show.
  it("cannot be left hanging by an unexpected throw", () => {
    expect(component).toMatch(/try \{\s*result = await finished;\s*\} catch \{/);
  });
});

describe("motion is honest and optional", () => {
  // The page lives outside `.pc-site`, so the marketing page's reduced-motion
  // block does not cover it. Without its own, every animation here would ignore
  // the user's operating-system setting.
  it("has its own prefers-reduced-motion block", () => {
    const scoped = css.slice(css.indexOf(".pcv-step"));
    expect(scoped).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(scoped).toMatch(/\.pcv \*/);
  });

  // Reduced motion is not only a CSS concern here: pacing the reveal IS
  // animation, so someone who asked for less of it gets every result at once.
  it("drops the reveal pacing, not just the CSS, under reduced motion", () => {
    expect(component).toContain("prefers-reduced-motion");
    expect(component).toMatch(/if \(floor\) await sleep\(floor\)/);
  });

  it("announces progress to screen readers, which the glyphs cannot", () => {
    expect(component).toMatch(/role="status"\s+aria-live="polite"/);
    expect(component).toContain("STATE_WORDS");
    // The list must NOT be the live region — it rewrites every step, and a
    // screen reader would re-read all eight rows each time.
    expect(component).not.toMatch(/<ol[^>]*aria-live/);
  });

  it("reveals real results rather than animating on a timer", () => {
    // The presenter waits on the verifier when it has nothing to show. If this
    // ever becomes a plain timed sequence, the durations on screen stop being
    // measurements and the page starts lying about what it did.
    expect(component).toContain("if (settled) break;");
    expect(component).toContain("applyStep(prev, at, step)");
  });

  // The bug this guards: `shown` was read from inside the setState updater,
  // which React invokes during a later render — after the counter had advanced.
  // Every result landed one row late, so a FORGED receipt rendered "Signature
  // matches the contents ✓" against a green rail. tests/receipt-steps.test.ts
  // covers the behaviour; this pins the shape that made it possible.
  it("binds the row index outside the updater, never reading a live counter", () => {
    expect(component).toMatch(/const at = shown;/);
    expect(component).not.toMatch(/i === shown/);
    expect(component).not.toMatch(/i > shown/);
  });

  // An unreachable key list is our outage, not a verdict on the receipt. The
  // Failure card already says so in words and in grey; a red rail on the panel
  // directly above it takes that back, which is the forged/unchecked split being
  // undone one element up from where it was carefully made.
  it("colours the inspection rail by failure KIND, not by 'a row failed'", () => {
    expect(component).not.toMatch(/failed \? "bg-destructive" : "bg-primary"/);
    expect(component).toMatch(/kind === "forged"\s*\?\s*"bg-destructive"/);
    expect(component).toMatch(/kind === "unchecked"\s*\?\s*"bg-muted-foreground"/);
    // The failing ROW carries the same distinction.
    expect(css).toMatch(/\.pcv-sequence\[data-kind="unchecked"\]/);
  });

  it("reports the summed check time, not the wall clock of the paced reveal", () => {
    // Wall clock includes the reveal floor (and a background tab's 1s timer
    // clamp), which reported seconds for milliseconds of work. The total must
    // be addable: summing the visible rows lands on the visible total.
    expect(component).toMatch(/queue\.reduce\(\(sum, step\) => sum \+ step\.ms, 0\)/);
    expect(component).not.toContain("performance.now() - startedAt");
  });
});
