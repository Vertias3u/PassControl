import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// `passcontrol login` — the two designs that must never come back.
//
// This is a source-shape guard, like its siblings, because both failures it pins
// are invisible at runtime in the happy path: a phished approval and a cloned
// repo both look exactly like a successful login to the person doing it.
//
// ── 1. The approval code is TYPED OR PASTED, never carried in the URL ────────
//
// An earlier draft opened `${origin}/dashboard/cli#code=FKDR-8T2W`, pre-filling
// the approval screen. In RFC 8628 the human moving the code from the terminal to
// the browser IS the channel binding — it is the only evidence that the person at
// the browser is the person at the terminal. Pre-fill removes it, and the attack
// is one click: the attacker runs `passcontrol login`, keeps the `device_code`,
// sends the victim the pre-filled link, and the signed-in victim clicks Approve.
// The attacker now holds a WRITE-scoped `pc_` key on the victim's tenant — create
// and revoke agents, rotate passports, move budgets, arm the kill switch.
//
// The clipboard copy this flow does ship is not the same thing and does not
// reopen this: an attacker cannot write to your clipboard from a link. The code
// reaches the browser from the process the operator launched on their own
// machine, so the binding survives. A URL is attacker-authored; a clipboard is not.
//
// ── 2. The Cloud path still never clones ────────────────────────────────────
//
// `tests/cli-cloud-path-no-clone.test.ts` pins which functions may clone, and
// `startDashboard` is legitimately one of them. That makes it blind to exactly
// the mistake `login` invites: `openDashboard` is not a URL opener — at
// bin/passcontrol.mjs it routes any localhost gateway through `startDashboard`,
// which is `ensureAppRoot({ clone: true })`. Reusing it from `login` would put a
// self-host clone back on the first command a Cloud user ever runs, as a NEW
// TRANSITIVE caller that the allowlist reports as unchanged.
//
// Hence `openUrl`: the platform spawn with no stack logic attached.

const CLI = fileURLToPath(new URL("../bin/passcontrol.mjs", import.meta.url));
const LOGIN = fileURLToPath(new URL("../cli/login.mjs", import.meta.url));
const APPROVAL_DIR = fileURLToPath(new URL("../app/dashboard/cli/", import.meta.url));

/**
 * Slice one function body out of a source file.
 *
 * The `+ 1` and the explicit `-1` check are both load-bearing, and this guard
 * silently passed a mutated `openDashboard` without them: searching from index 0
 * re-matches the declaration the slice starts at, so the "body" became the whole
 * rest of the file — and `openUrl(` appears later in it no matter what
 * `openDashboard` does. `search` also returns -1 rather than a falsy value on no
 * match, so `|| undefined` truncated the last character instead of taking the
 * remainder. The sibling guards in tests/credential-*.test.ts get both right;
 * this copied the shape and dropped them.
 */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, "mu"));
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/^(?:export )?(?:async )?function \w/mu);
  return rest.slice(0, next === -1 ? undefined : next);
}

/**
 * Source with comments removed.
 *
 * Every check below is about what the CODE does, and the comments in these files
 * deliberately NAME the designs being rejected — the pre-filled `#code=` link,
 * and `openDashboard`'s route through `startDashboard` into a clone. That prose
 * is the reason the mistakes stay rejected, so a guard that forbade the words
 * would delete its own explanation. Strip, then assert.
 *
 * Crude on purpose: a `//` inside a string literal would be miscounted. These
 * are two small files that contain no such thing, and a real parser here would
 * be more machinery than the guard is worth.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
}

/** Read a file that does not exist yet, failing with the path rather than ENOENT. */
function readWhenWritten(file: string, what: string): string {
  expect(fs.existsSync(file), `${what} not written yet: ${file}`).toBe(true);
  return fs.readFileSync(file, "utf8");
}

describe("passcontrol login carries no code in the URL", () => {
  it("opens /dashboard/cli with no fragment and no query", () => {
    const source = code(readWhenWritten(LOGIN, "cli/login.mjs"));
    // Every literal mention of the approval route, up to whatever terminates the
    // string it sits in. A `#` or `?` inside any of them is the rejected design.
    const routes = [...source.matchAll(/\/dashboard\/cli[^"'`\s)]*/gu)].map((m) => m[0]);
    expect(routes.length, "cli/login.mjs must name the approval route").toBeGreaterThan(0);
    const carrying = routes.filter((route) => route.includes("#") || route.includes("?"));
    expect(carrying, "the user_code may not travel in the URL").toEqual([]);
    // …and no other route may smuggle it either.
    expect(source).not.toMatch(/[#?]code=/u);
  });

  it("does not build the approval screen from the URL", () => {
    // The browser half of the same rule. If the CLI stops sending a fragment but
    // the page still reads one, the design is one commit away from returning.
    expect(fs.existsSync(APPROVAL_DIR), `approval screen not written yet: ${APPROVAL_DIR}`).toBe(true);
    const files = fs
      .readdirSync(APPROVAL_DIR, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.tsx?$/u.test(f));
    expect(files.length, "app/dashboard/cli must contain the approval screen").toBeGreaterThan(0);
    for (const file of files) {
      const source = code(fs.readFileSync(`${APPROVAL_DIR}${file}`, "utf8"));
      expect(source, `${file} may not read the code from the URL`).not.toMatch(
        /location\.hash|location\.search|searchParams|useSearchParams/u,
      );
    }
  });
});

describe("passcontrol login cannot reach the self-host clone", () => {
  it("names neither startDashboard nor ensureAppRoot", () => {
    // The transitive-clone pin. See the header — the sibling allowlist test
    // structurally cannot catch this, because the cloning caller it would name is
    // one that legitimately clones.
    const source = code(readWhenWritten(LOGIN, "cli/login.mjs"));
    expect(source).not.toMatch(/\bstartDashboard\b/u);
    expect(source).not.toMatch(/\bensureAppRoot\b/u);
    expect(source).not.toMatch(/\bopenDashboard\b/u);
  });

  it("opens URLs through openUrl, which openDashboard also uses", () => {
    // openUrl is the spawn and the `child.on("error")` degradation, with no stack
    // logic. Keeping openDashboard on it is what stops the two drifting apart —
    // a second hand-rolled spawn would pass the assertion above and lose the
    // "print the URL when the browser will not open" fallback.
    const cli = fs.readFileSync(CLI, "utf8");
    expect(cli, "extract openUrl from openDashboard").toMatch(
      /^(?:export )?(?:async )?function openUrl\b/mu,
    );
    expect(functionBody(cli, "openDashboard"), "openDashboard must delegate to openUrl").toMatch(
      /openUrl\(/u,
    );
  });
});

describe("passcontrol login survives a machine with no clipboard tool", () => {
  // LIMITATION, stated rather than papered over: this is the weak half of the
  // guarantee. What actually matters — that the code is printed even when the
  // copy fails — is behavioural, and is asserted in tests/cli-login.test.ts by
  // running the CLI with the clipboard binaries stripped from PATH. A source
  // grep cannot tell a print outside the branch from one inside it.
  //
  // What IS worth pinning here is that neither clipboard failure mode can take
  // the login down, because both are easy to miss: `child.on("error")` fires for
  // a binary that is absent, and it does NOT fire for one that is present and
  // exits non-zero. On Linux none of wl-copy / xclip / xsel is guaranteed
  // installed, so the absent case is the common one, not the exotic one.
  it("handles both clipboard failure modes", () => {
    const source = code(readWhenWritten(LOGIN, "cli/login.mjs"));
    const body = functionBody(source, "copyToClipboard");
    expect(body, "a missing clipboard binary must not throw").toMatch(/\.on\(\s*["']error["']/u);
    expect(body, "a present-but-failing clipboard binary must not throw").toMatch(/code|exit|status/u);
    // pbcopy does not exit until stdin closes, so a forgotten end() hangs login.
    expect(body, "close stdin or the copy never completes").toMatch(/stdin[\s\S]{0,40}end\(\)/u);
  });
});

// ── The envelope, pinned to the routes rather than to a stub ────────────────
//
// Every control route answers `{ data: ... }` (lib/control/respond.ts). The CLI
// files under cli/ carry their OWN fetch helpers rather than using
// bin/passcontrol.mjs's `api()`, because login runs before any API key exists —
// and `api()` is the thing that has always unwrapped the envelope. Two of those
// helpers did not, so they read `.agents` and `.id` one level too high: the agent
// list was permanently empty, `login`'s reuse-and-rotate branch was unreachable,
// and `logout` could not name the agent it was logging out of.
//
// The suite did not catch it because the stubs answered `{ agents: [...] }` — a
// shape invented to match the reader instead of the route. A stub that invents
// the shape it is asked about certifies whatever the code already does, so this
// guard reads the ROUTE and the HELPER and insists they agree.
describe("the CLI's own control helpers unwrap what the routes actually send", () => {
  const ROUTE = "app/api/control/v1/agents/route.ts";
  const HELPERS = ["cli/login.mjs", "cli/logout.mjs", "cli/selftest.mjs"];

  it("the routes really do wrap in `data` — otherwise this guard is backwards", async () => {
    const source = await readFile(new URL(`../${ROUTE}`, import.meta.url), "utf8");
    expect(source, `${ROUTE} no longer answers { data: ... }`).toMatch(/jsonResponse\(\s*\{\s*data:/u);
  });

  it.each(HELPERS)("%s unwraps it", async (file) => {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    expect(
      source,
      `${file} fetches the control plane but never unwraps \`data\`, so its callers read the envelope`
    ).toMatch(/"data" in parsed/u);
  });
});
