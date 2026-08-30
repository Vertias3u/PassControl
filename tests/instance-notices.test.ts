import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RESERVED_HANDLES } from "@/lib/profile/handle";

const MARK = "curate:";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function selfhostPage(path: string): string {
  const selfhost = path.replace(/page\.tsx$/u, "page.selfhost.tsx");
  return source(existsSync(resolve(process.cwd(), selfhost)) ? selfhost : path);
}

function curated(path: string): string {
  const withoutPrivate = source(path).replace(
    new RegExp(`^[^\\n]*${MARK}private-start.*?${MARK}private-end[^\\n]*\\n`, "gms"),
    ""
  );
  const output: string[] = [];
  let publicOnly = false;
  for (const line of withoutPrivate.split("\n")) {
    if (line.includes(`${MARK}public-only-start`)) { publicOnly = true; continue; }
    if (line.includes(`${MARK}public-only-end`)) { publicOnly = false; continue; }
    output.push(publicOnly ? line.replace(/^(\s*)\/\/ ?/u, "$1") : line);
  }
  return output.join("\n");
}

describe("generic instance notices", () => {
  it("ships public, prerender-safe notice routes", () => {
    const middleware = curated("middleware.ts");
    const csp = curated("lib/csp.ts");
    expect(middleware).toContain('"/notices"');
    for (const path of ["/notices", "/notices/data", "/notices/recovery"]) {
      expect(csp).toContain(`"${path}"`);
    }
    expect(curated("lib/profile/handle.ts")).toContain('"notices"');
  });

  it("frames the documents as software facts owned by the instance operator", () => {
    const pages = [
      selfhostPage("app/notices/page.tsx"),
      selfhostPage("app/notices/data/page.tsx"),
      selfhostPage("app/notices/recovery/page.tsx"),
    ].join("\n");

    expect(pages).toMatch(/operator of this instance/i);
    expect(pages).toMatch(/responsible for (?:the )?terms/i);
    expect(pages).toMatch(/provider (?:API )?keys/i);
    expect(pages).toMatch(/prompts or model responses/i);
    expect(pages).not.toMatch(/Vertias|Kristiyan Ivanov|Sofia|Bulgaria|passcontrol\.vertias\.eu/i);
  });

  it("distinguishes restored credential verifiers from revealable bearer secrets", () => {
    const recovery = selfhostPage("app/notices/recovery/page.tsx");

    expect(recovery).toMatch(/A database restore can\s+restore those verifier rows/);
    expect(recovery).toMatch(/cannot reveal the original bearer values/);
    expect(recovery).toMatch(/A configuration export contains\s+neither/);
  });



  it("does not undo Core's 0044 reservation", () => {
    const coreMigration = curated("db/migrations/0045_instance_notices_boundary.sql");

    expect(coreMigration).not.toContain("delete from public.reserved_usernames");
    expect(coreMigration).toContain("select 1;");
  });

  it("rewires only Core signup and recovery links", () => {
    const auth = curated("components/auth/AuthShell.tsx");
    const recovery = curated("components/RecoveryPanel.tsx");

    expect(auth).toContain('href="/notices/data"');
    expect(auth).not.toContain("/legal/");
    expect(recovery).toContain('return "/notices/recovery"');
    const hostedRecoveryHref = ['href="/legal', '/recovery"'].join("");
    expect(recovery).not.toContain(hostedRecoveryHref);
  });
});
