// Any-API phase 1: the pure pieces the service route is built from.
//
// Rules are tenant-written and read live, so they are re-validated here on
// every read — a PATCH straight to agents.service_rules must not be able to
// widen what the dashboard editor would have refused (plans/any-api-credentials.md
// §3). Malformed means "this service is denied", never "this rule is skipped":
// a skipped rule in an allowlist is a no-op, but a skipped cap is not.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVICE_HOURLY_CAP,
  matchServiceRule,
  parseServiceRules,
  serviceRulesRevision,
} from "@/lib/services/rules";
import { parseServicePath } from "@/lib/services/path";
import { SERVICE_CATALOG, isServiceId, serviceRefusal } from "@/lib/services/catalog";
import {
  filterRequestHeaders,
  filterResponseHeaders,
  rewriteLinkHeader,
  rewriteLocationHeader,
} from "@/lib/services/wire";

const github = SERVICE_CATALOG.github;

describe("parseServiceRules", () => {
  const ok = (raw: unknown) => {
    const parsed = parseServiceRules(raw, "github");
    if (parsed.kind !== "rules") throw new Error(`expected rules, got ${JSON.stringify(parsed)}`);
    return parsed.rules;
  };

  it("reads a valid read-only rule set", () => {
    const rules = ok({
      github: {
        allow: [
          { method: "GET", path: "/repos/acme/*/issues" },
          { method: "GET", path: "/repos/acme/web/**" },
        ],
        max_requests_per_hour: 200,
      },
    });
    expect(rules.allow).toHaveLength(2);
    expect(rules.maxRequestsPerHour).toBe(200);
  });

  it("gives a missing hourly cap the documented default, never unlimited", () => {
    const rules = ok({ github: { allow: [{ method: "GET", path: "/user" }] } });
    expect(rules.maxRequestsPerHour).toBe(DEFAULT_SERVICE_HOURLY_CAP);
    expect(DEFAULT_SERVICE_HOURLY_CAP).toBeGreaterThan(0);
  });

  it.each([
    ["no column value", null],
    ["no entry for this service", { slack: { allow: [] } }],
  ])("reads %s as no access (deny by default)", (_label, raw) => {
    expect(parseServiceRules(raw, "github")).toEqual({ kind: "none" });
  });

  it.each([
    ["a non-object document", "[]"],
    ["an array document", []],
    ["an entry that is not an object", { github: "all" }],
    ["allow that is not an array", { github: { allow: { method: "GET", path: "/user" } } }],
    ["an unknown key in the entry", { github: { allow: [], deny: [] } }],
    ["an unknown key in a rule", { github: { allow: [{ method: "GET", path: "/user", note: 1 }] } }],
    ["a write with a trailing ** (write rules are exact)", { github: { allow: [{ method: "POST", path: "/repos/a/b/**" }] } }],
    ["a DELETE with a trailing **", { github: { allow: [{ method: "DELETE", path: "/repos/acme/**" }] } }],
    ["OPTIONS (not a rule method)", { github: { allow: [{ method: "OPTIONS", path: "/user" }] } }],
    ["a lower-case method", { github: { allow: [{ method: "get", path: "/user" }] } }],
    ["a wildcard method", { github: { allow: [{ method: "*", path: "/user" }] } }],
    ["HEAD written explicitly (it follows GET)", { github: { allow: [{ method: "HEAD", path: "/user" }] } }],
    ["a path without a leading slash", { github: { allow: [{ method: "GET", path: "user" }] } }],
    ["an empty segment", { github: { allow: [{ method: "GET", path: "/repos//issues" }] } }],
    ["a trailing slash", { github: { allow: [{ method: "GET", path: "/user/" }] } }],
    ["a dot segment", { github: { allow: [{ method: "GET", path: "/repos/./x" }] } }],
    ["a dot-dot segment", { github: { allow: [{ method: "GET", path: "/repos/../x" }] } }],
    ["a partial wildcard", { github: { allow: [{ method: "GET", path: "/repos/acme-*/x" }] } }],
    ["** anywhere but last", { github: { allow: [{ method: "GET", path: "/repos/**/issues" }] } }],
    ["a query string", { github: { allow: [{ method: "GET", path: "/user?x=1" }] } }],
    ["a backslash", { github: { allow: [{ method: "GET", path: "/repos\\x" }] } }],
    ["a control character", { github: { allow: [{ method: "GET", path: "/repos/\u0000" }] } }],
    ["a percent-escape (rules are written decoded)", { github: { allow: [{ method: "GET", path: "/repos/a%2Fb" }] } }],
    ["a zero cap", { github: { allow: [], max_requests_per_hour: 0 } }],
    ["a fractional cap", { github: { allow: [], max_requests_per_hour: 1.5 } }],
    ["a string cap", { github: { allow: [], max_requests_per_hour: "100" } }],
    ["a cap over the ceiling", { github: { allow: [], max_requests_per_hour: 1_000_001 } }],
  ])("refuses %s as malformed", (_label, raw) => {
    expect(parseServiceRules(raw, "github").kind).toBe("malformed");
  });

  it("bounds the rule count and a pattern's size", () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ method: "GET", path: `/repos/acme/r${i}` }));
    expect(parseServiceRules({ github: { allow: many } }, "github").kind).toBe("malformed");
    const deep = "/" + Array.from({ length: 33 }, () => "a").join("/");
    expect(parseServiceRules({ github: { allow: [{ method: "GET", path: deep }] } }, "github").kind).toBe(
      "malformed"
    );
    const long = "/" + "a".repeat(257);
    expect(parseServiceRules({ github: { allow: [{ method: "GET", path: long }] } }, "github").kind).toBe(
      "malformed"
    );
  });

  it("judges each service on its own: a bad slack entry leaves github readable", () => {
    const raw = { github: { allow: [{ method: "GET", path: "/user" }] }, slack: "garbage" };
    expect(parseServiceRules(raw, "github").kind).toBe("rules");
    expect(parseServiceRules(raw, "slack").kind).toBe("malformed");
  });
});

describe("matchServiceRule", () => {
  const rules = (() => {
    const parsed = parseServiceRules(
      {
        github: {
          allow: [
            { method: "GET", path: "/repos/acme/*/issues" },
            { method: "GET", path: "/repos/acme/web/**" },
            { method: "GET", path: "/user" },
          ],
        },
      },
      "github"
    );
    if (parsed.kind !== "rules") throw new Error("setup");
    return parsed.rules;
  })();

  it("matches * to exactly one segment", () => {
    expect(matchServiceRule(rules, "GET", ["repos", "acme", "api", "issues"])?.path).toBe("/repos/acme/*/issues");
    expect(matchServiceRule(rules, "GET", ["repos", "acme", "issues"])).toBeNull();
    expect(matchServiceRule(rules, "GET", ["repos", "acme", "a", "b", "issues"])).toBeNull();
  });

  it("matches ** to one or more trailing segments, not zero", () => {
    expect(matchServiceRule(rules, "GET", ["repos", "acme", "web", "pulls", "7", "files"])?.path).toBe(
      "/repos/acme/web/**"
    );
    expect(matchServiceRule(rules, "GET", ["repos", "acme", "web"])).toBeNull();
  });

  it("lets HEAD through exactly where GET is allowed", () => {
    expect(matchServiceRule(rules, "HEAD", ["user"])?.path).toBe("/user");
    expect(matchServiceRule(rules, "HEAD", ["orgs", "acme"])).toBeNull();
  });

  it("never matches a write", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(matchServiceRule(rules, method, ["user"])).toBeNull();
    }
  });

  it("compares literal segments exactly (case-sensitive: a miss refuses, it never widens)", () => {
    expect(matchServiceRule(rules, "GET", ["repos", "ACME", "api", "issues"])).toBeNull();
    expect(matchServiceRule(rules, "GET", ["User"])).toBeNull();
  });

  it("denies everything for an empty allow list", () => {
    const parsed = parseServiceRules({ github: { allow: [] } }, "github");
    if (parsed.kind !== "rules") throw new Error("setup");
    expect(matchServiceRule(parsed.rules, "GET", ["user"])).toBeNull();
  });
});

describe("write rules (phase 2)", () => {
  const writes = (allow: { method: string; path: string }[]) => {
    const parsed = parseServiceRules({ github: { allow } }, "github");
    if (parsed.kind !== "rules") throw new Error(`expected rules, got ${JSON.stringify(parsed)}`);
    return parsed.rules;
  };

  it("reads POST, PUT, PATCH and DELETE rules with literal and single-segment wildcards", () => {
    const rules = writes([
      { method: "POST", path: "/repos/acme/*/issues" },
      { method: "PUT", path: "/repos/acme/web/contents/README.md" },
      { method: "PATCH", path: "/repos/acme/web/issues/*" },
      { method: "DELETE", path: "/repos/acme/web/issues/*/labels/*" },
    ]);
    expect(rules.allow.map((r) => r.method)).toEqual(["POST", "PUT", "PATCH", "DELETE"]);
  });

  it("admits a write only for the method its rule names", () => {
    const rules = writes([{ method: "POST", path: "/repos/acme/*/issues" }]);
    expect(matchServiceRule(rules, "POST", ["repos", "acme", "web", "issues"])?.path).toBe("/repos/acme/*/issues");
    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(matchServiceRule(rules, method, ["repos", "acme", "web", "issues"])).toBeNull();
    }
  });

  it("never lets a GET rule admit a write, or HEAD ride on a write rule", () => {
    const rules = writes([
      { method: "GET", path: "/repos/acme/web/**" },
      { method: "DELETE", path: "/repos/acme/web/issues/*" },
    ]);
    expect(matchServiceRule(rules, "DELETE", ["repos", "acme", "web", "pulls", "1"])).toBeNull();
    expect(matchServiceRule(rules, "POST", ["repos", "acme", "web", "issues"])).toBeNull();
    expect(matchServiceRule(rules, "HEAD", ["repos", "acme", "web", "issues", "1"])?.method).toBe("GET");
  });
});

describe("serviceRulesRevision", () => {
  it("is stable for the same rules and changes when a rule or the cap changes", () => {
    const a = parseServiceRules({ github: { allow: [{ method: "GET", path: "/user" }] } }, "github");
    const b = parseServiceRules({ github: { allow: [{ method: "GET", path: "/user" }] } }, "github");
    const c = parseServiceRules({ github: { allow: [{ method: "GET", path: "/orgs" }] } }, "github");
    const d = parseServiceRules(
      { github: { allow: [{ method: "GET", path: "/user" }], max_requests_per_hour: 5 } },
      "github"
    );
    if (a.kind !== "rules" || b.kind !== "rules" || c.kind !== "rules" || d.kind !== "rules") throw new Error("setup");
    expect(serviceRulesRevision("github", a.rules)).toBe(serviceRulesRevision("github", b.rules));
    expect(serviceRulesRevision("github", a.rules)).not.toBe(serviceRulesRevision("github", c.rules));
    expect(serviceRulesRevision("github", a.rules)).not.toBe(serviceRulesRevision("github", d.rules));
    expect(serviceRulesRevision("github", a.rules)).toMatch(/^[0-9a-f]{16,}$/u);
  });
});

describe("parseServicePath", () => {
  const P = "/api/v1/svc/github";

  it("returns decoded segments and the re-encoded upstream path", () => {
    expect(parseServicePath(`${P}/repos/acme/web/issues`, "github")).toEqual({
      ok: true,
      segments: ["repos", "acme", "web", "issues"],
      upstreamPath: "/repos/acme/web/issues",
    });
  });

  it("decodes once and re-encodes, so a double-encoded dot-dot stays a literal name", () => {
    const parsed = parseServicePath(`${P}/repos/acme/%252e%252e/issues`, "github");
    expect(parsed).toEqual({
      ok: true,
      segments: ["repos", "acme", "%2e%2e", "issues"],
      upstreamPath: "/repos/acme/%252e%252e/issues",
    });
  });

  it("keeps a branch name with unusual characters intact", () => {
    const parsed = parseServicePath(`${P}/repos/acme/web/branches/feat%40x`, "github");
    expect(parsed.ok && parsed.segments.at(-1)).toBe("feat@x");
    expect(parsed.ok && parsed.upstreamPath).toBe("/repos/acme/web/branches/feat%40x");
  });

  it.each([
    ["no path at all", P],
    ["only a slash", `${P}/`],
    ["an empty segment", `${P}/repos//issues`],
    ["a trailing slash", `${P}/user/`],
    ["an encoded slash", `${P}/repos/acme%2Fweb/issues`],
    ["an encoded backslash", `${P}/repos/acme%5Cweb/issues`],
    ["an encoded dot-dot", `${P}/repos/%2e%2e/issues`],
    ["an encoded dot", `${P}/repos/%2E/issues`],
    ["a literal dot-dot", `${P}/repos/../issues`],
    ["an encoded NUL", `${P}/repos/a%00b`],
    ["a broken escape", `${P}/repos/%E0%A4%A`],
    ["the wrong service prefix", "/api/v1/svc/slack/user"],
    ["a prefix look-alike", "/api/v1/svc/githubx/user"],
  ])("refuses %s", (_label, pathname) => {
    expect(parseServicePath(pathname, "github").ok).toBe(false);
  });

  it("bounds depth and segment length", () => {
    expect(parseServicePath(`${P}/${Array.from({ length: 33 }, () => "a").join("/")}`, "github").ok).toBe(false);
    expect(parseServicePath(`${P}/${"a".repeat(257)}`, "github").ok).toBe(false);
  });
});

describe("the GitHub catalog entry", () => {
  it("knows github and telegram and nothing else yet, and svc ids never look like providers", () => {
    expect(isServiceId("github")).toBe(true);
    expect(isServiceId("telegram")).toBe(true);
    expect(isServiceId("slack")).toBe(false);
    expect(isServiceId("__proto__")).toBe(false);
    expect(github.credentialProvider).toBe("svc:github");
    expect(github.origin).toBe("https://api.github.com");
  });

  it("refuses GraphQL whatever the rules say: one endpoint that can do anything (T3)", () => {
    expect(serviceRefusal(github, "POST", ["graphql"])).toMatch(/graphql/i);
    expect(serviceRefusal(github, "GET", ["graphql"])).toMatch(/graphql/i);
    expect(serviceRefusal(github, "GET", ["repos", "acme", "web"])).toBeNull();
  });

  it("injects the token as a Bearer credential with a gateway User-Agent, and never in the URL", () => {
    const headers = github.authHeaders("ghp_example");
    expect(headers.authorization).toBe("Bearer ghp_example");
    expect(headers["user-agent"]).toMatch(/PassControl/);
    expect(github.upstreamUrl("ghp_example", "/repos/a/b", "?page=2")).toBe("https://api.github.com/repos/a/b?page=2");
  });
});

// Writes that change who can reach a repository, where its events go, what
// secrets it holds or whether it exists at all. Refused whatever the tenant's
// rules say: a rule is written by a person in a hurry, and `DELETE /repos/*/*`
// would otherwise be one keystroke from deleting every repository the token
// reaches. Refusing more is the safe direction; the owner can loosen the list.
describe("the GitHub never list (writes refused whatever the rules say)", () => {
  const seg = (path: string) => path.slice(1).split("/");
  it.each([
    ["DELETE", "/repos/acme/web"],
    ["PATCH", "/repos/acme/web"],
    ["POST", "/repos/acme/web/transfer"],
    ["PUT", "/repos/acme/web/collaborators/mallory"],
    ["DELETE", "/repos/acme/web/collaborators/alice"],
    ["PATCH", "/repos/acme/web/invitations/7"],
    ["POST", "/repos/acme/web/hooks"],
    ["PATCH", "/repos/acme/web/hooks/1/config"],
    ["POST", "/repos/acme/web/keys"],
    ["PUT", "/repos/acme/web/actions/secrets/AWS_KEY"],
    ["POST", "/repos/acme/web/actions/variables"],
    ["PUT", "/repos/acme/web/actions/permissions"],
    ["POST", "/repos/acme/web/actions/runners/registration-token"],
    ["PUT", "/repos/acme/web/environments/prod"],
    ["PUT", "/repos/acme/web/environments/prod/secrets/X"],
    ["PUT", "/repos/acme/web/dependabot/secrets/X"],
    ["PUT", "/repos/acme/web/codespaces/secrets/X"],
    ["PATCH", "/repos/acme/web/secret-scanning/alerts/3"],
    ["PATCH", "/repos/acme/web/code-scanning/alerts/3"],
    ["DELETE", "/repos/acme/web/branches/main/protection"],
    ["POST", "/repos/acme/web/branches/main/protection/enforce_admins"],
    ["POST", "/repos/acme/web/rulesets"],
    ["DELETE", "/repos/acme/web/vulnerability-alerts"],
    ["DELETE", "/repos/acme/web/automated-security-fixes"],
    ["POST", "/user/keys"],
    ["POST", "/user/repos"],
    ["PATCH", "/user"],
    ["PUT", "/orgs/acme/memberships/mallory"],
    ["POST", "/orgs/acme/hooks"],
    ["PATCH", "/orgs/acme"],
    ["DELETE", "/authorizations/1"],
    ["DELETE", "/applications/abc/token"],
  ])("refuses %s %s", (method, path) => {
    expect(serviceRefusal(github, method, seg(path))).not.toBeNull();
  });

  // GitHub serves every repository by numeric id too (`/repositories/{id}`,
  // the form its own pagination links use). Verified live 2026-10-02: GET
  // /repositories/<id> returned the private repo. A rule like `DELETE /*/*`
  // matches it, so the never list must see the same repository through it.
  it.each([
    ["DELETE", "/repositories/1398731839"],
    ["PATCH", "/repositories/1398731839"],
    ["POST", "/repositories/1398731839/hooks"],
    ["PUT", "/repositories/1398731839/collaborators/mallory"],
    ["POST", "/repositories/1398731839/keys"],
    ["PUT", "/repositories/1398731839/actions/secrets/X"],
    ["DELETE", "/repositories/1398731839/branches/main/protection"],
    ["POST", "/repositories/1398731839/transfer"],
    ["DELETE", "/REPOSITORIES/1398731839"],
    ["POST", "/Repositories/1/Hooks"],
  ])("refuses %s %s: the numeric-id form of the same repository", (method, path) => {
    expect(serviceRefusal(github, method, seg(path))).not.toBeNull();
  });

  // Owner decision 2026-10-02: also refused. A workflow file runs code with the
  // repository's secrets; `.github/` also holds local actions those workflows
  // run and CODEOWNERS, which decides who must review. And a ref update or
  // delete can move or remove a branch's history (a force update is a body
  // flag, so every update is refused; creating a branch is not).
  it.each([
    ["PUT", "/repos/acme/web/contents/.github/workflows/ci.yml"],
    ["DELETE", "/repos/acme/web/contents/.github/workflows/ci.yml"],
    ["PUT", "/repos/acme/web/contents/.github/actions/setup/action.yml"],
    ["PUT", "/repos/acme/web/contents/.github/CODEOWNERS"],
    ["PUT", "/repos/acme/web/contents/.GITHUB/Workflows/x.yml"],
    ["PUT", "/repositories/1/contents/.github/workflows/ci.yml"],
    ["PATCH", "/repos/acme/web/git/refs/heads/main"],
    ["DELETE", "/repos/acme/web/git/refs/heads/feature"],
    ["DELETE", "/repos/acme/web/git/refs/tags/v1"],
    ["POST", "/repos/acme/web/branches/main/rename"],
  ])("refuses %s %s (workflow files and ref changes)", (method, path) => {
    expect(serviceRefusal(github, method, seg(path))).not.toBeNull();
  });

  it("still lets a write create a branch or change other files", () => {
    expect(serviceRefusal(github, "POST", seg("/repos/acme/web/git/refs"))).toBeNull();
    expect(serviceRefusal(github, "PUT", seg("/repos/acme/web/contents/notes/README.md"))).toBeNull();
    expect(serviceRefusal(github, "PUT", seg("/repos/acme/web/contents/src/github/x.ts"))).toBeNull();
    expect(serviceRefusal(github, "GET", seg("/repos/acme/web/contents/.github/workflows/ci.yml"))).toBeNull();
  });

  it("leaves ordinary writes and every read through the numeric-id form alone", () => {
    expect(serviceRefusal(github, "POST", seg("/repositories/1/issues"))).toBeNull();
    expect(serviceRefusal(github, "GET", seg("/repositories/1"))).toBeNull();
    expect(serviceRefusal(github, "GET", seg("/repositories/1/hooks"))).toBeNull();
  });

  it("refuses them however the path is cased, since a rule's `*` matches any casing", () => {
    expect(serviceRefusal(github, "DELETE", ["REPOS", "Acme", "Web"])).not.toBeNull();
    expect(serviceRefusal(github, "POST", ["Repos", "acme", "web", "Hooks"])).not.toBeNull();
    expect(serviceRefusal(github, "PUT", ["repos", "acme", "web", "ACTIONS", "Secrets", "X"])).not.toBeNull();
  });

  it("does not refuse READS of the same paths: the list is about changes", () => {
    for (const path of ["/repos/acme/web", "/repos/acme/web/hooks", "/repos/acme/web/collaborators", "/user"]) {
      expect(serviceRefusal(github, "GET", seg(path))).toBeNull();
      expect(serviceRefusal(github, "HEAD", seg(path))).toBeNull();
    }
  });

  it.each([
    ["POST", "/repos/acme/web/issues"],
    ["POST", "/repos/acme/web/issues/1/comments"],
    ["PATCH", "/repos/acme/web/issues/1"],
    ["POST", "/repos/acme/web/issues/1/labels"],
    ["DELETE", "/repos/acme/web/issues/1/labels/bug"],
    ["POST", "/repos/acme/web/pulls"],
    ["PUT", "/repos/acme/web/pulls/1/merge"],
    ["PUT", "/repos/acme/web/contents/README.md"],
    ["POST", "/repos/acme/web/actions/workflows/ci.yml/dispatches"],
  ])("leaves an ordinary write to the tenant's rules: %s %s", (method, path) => {
    expect(serviceRefusal(github, method, seg(path))).toBeNull();
  });
});

describe("header allowlists", () => {
  it("forwards only the listed request headers, and never the agent's own credential", () => {
    const incoming = new Headers({
      authorization: "Bearer pc_agent_visa",
      "x-api-key": "pc_agent_key",
      cookie: "a=b",
      accept: "application/vnd.github+json",
      "x-github-api-version": "2026-03-10",
      "if-none-match": 'W/"abc"',
      "x-forwarded-for": "1.2.3.4",
      "user-agent": "octokit/1.0",
      "content-type": "application/json",
      // A method override would let a GET the rules admitted act as a write
      // upstream. Never forwarded, whatever phase.
      "x-http-method-override": "DELETE",
      "x-http-method": "DELETE",
      "x-method-override": "DELETE",
    });
    expect(Object.fromEntries(filterRequestHeaders(github, incoming))).toEqual({
      accept: "application/vnd.github+json",
      "x-github-api-version": "2026-03-10",
      "if-none-match": 'W/"abc"',
      "content-type": "application/json",
    });
  });

  it("drops an allowlisted header whose value is oversized or carries control characters", () => {
    const incoming = new Headers({
      accept: "a".repeat(1025),
      "x-github-api-version": "2026-03-10\u0001",
      "if-none-match": 'W/"ok"',
    });
    expect(Object.fromEntries(filterRequestHeaders(github, incoming))).toEqual({ "if-none-match": 'W/"ok"' });
  });

  it("passes back only the listed response headers", () => {
    const upstream = new Headers({
      "content-type": "application/json; charset=utf-8",
      etag: 'W/"abc"',
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": "1790000000",
      "retry-after": "60",
      "set-cookie": "logged_in=no",
      "x-oauth-scopes": "repo, admin:org",
      "x-accepted-oauth-scopes": "repo",
      server: "github.com",
    });
    const kept = Object.fromEntries(filterResponseHeaders(github, upstream));
    expect(kept).toEqual({
      "content-type": "application/json; charset=utf-8",
      etag: 'W/"abc"',
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": "1790000000",
      "retry-after": "60",
    });
  });
});

describe("rewriteLinkHeader (T7)", () => {
  const base = "https://gw.example/api/v1/svc/github";

  it("keeps the path the agent asked for and takes only the page query from GitHub", () => {
    // GitHub's own example: pagination links name the repository by numeric id.
    const link =
      '<https://api.github.com/repositories/1300192/issues?page=2>; rel="prev", ' +
      '<https://api.github.com/repositories/1300192/issues?page=4>; rel="next", ' +
      '<https://api.github.com/repositories/1300192/issues?page=515>; rel="last", ' +
      '<https://api.github.com/repositories/1300192/issues?page=1>; rel="first"';
    expect(rewriteLinkHeader(link, base, "/repos/acme/web/issues", github.origin)).toBe(
      `<${base}/repos/acme/web/issues?page=2>; rel="prev", ` +
        `<${base}/repos/acme/web/issues?page=4>; rel="next", ` +
        `<${base}/repos/acme/web/issues?page=515>; rel="last", ` +
        `<${base}/repos/acme/web/issues?page=1>; rel="first"`
    );
  });

  it("keeps per_page and cursor parameters", () => {
    const link = '<https://api.github.com/user/repos?per_page=2&after=Y3Vyc29y>; rel="next"';
    expect(rewriteLinkHeader(link, base, "/user/repos", github.origin)).toBe(
      `<${base}/user/repos?per_page=2&after=Y3Vyc29y>; rel="next"`
    );
  });

  it("drops a link to any other origin, and any rel that is not pagination", () => {
    const link =
      '<https://evil.example/x?page=2>; rel="next", ' +
      '<https://api.github.com.evil.example/x?page=2>; rel="prev", ' +
      '<https://api.github.com/repos/acme/web/issues?page=3>; rel="alternate"';
    expect(rewriteLinkHeader(link, base, "/repos/acme/web/issues", github.origin)).toBeNull();
  });

  it("returns null for an unparseable header rather than passing it through", () => {
    expect(rewriteLinkHeader("not a link header", base, "/user", github.origin)).toBeNull();
    expect(rewriteLinkHeader("", base, "/user", github.origin)).toBeNull();
  });
});

describe("rewriteLocationHeader (T6)", () => {
  const base = "https://gw.example/api/v1/svc/github";

  it("passes another host's redirect through untouched, for the agent to follow without a key", () => {
    const codeload = "https://codeload.github.com/acme/web/legacy.tar.gz/refs/heads/main";
    expect(rewriteLocationHeader(codeload, base, github.origin)).toBe(codeload);
  });

  it("sends a redirect on api.github.com back through the gateway, path and query intact", () => {
    expect(rewriteLocationHeader("https://api.github.com/repositories/42/issues?page=2", base, github.origin)).toBe(
      `${base}/repositories/42/issues?page=2`
    );
  });

  it("drops a relative, non-https or unparseable location", () => {
    expect(rewriteLocationHeader("/repositories/42", base, github.origin)).toBeNull();
    expect(rewriteLocationHeader("http://api.github.com/x", base, github.origin)).toBeNull();
    expect(rewriteLocationHeader("javascript:alert(1)", base, github.origin)).toBeNull();
    expect(rewriteLocationHeader("::", base, github.origin)).toBeNull();
  });
});

// Telegram (phase 2, slice E). Its token is IN THE URL PATH
// (`https://api.telegram.org/bot<token>/METHOD_NAME`), every method accepts GET
// and POST, and method names are case-insensitive (core.telegram.org/bots/api,
// "Making requests", read 2026-10-02). So a rule names a method, never a verb;
// matching and refusals ignore case; and a token that is not shaped like one
// is never put into a URL, where a `/` or `?` in it would change the address.
describe("Telegram", () => {
  const telegram = SERVICE_CATALOG.telegram;
  const TG = "123456789:AAH4dGVzdC10b2tlbi1mb3ItcGFzc2NvbnRyb2w";
  const ok = (allow: unknown[]) => {
    const parsed = parseServiceRules({ telegram: { allow } }, "telegram");
    if (parsed.kind !== "rules") throw new Error(`expected rules, got ${JSON.stringify(parsed)}`);
    return parsed.rules;
  };

  it("stores its token as svc:telegram and calls api.telegram.org", () => {
    expect(telegram.credentialProvider).toBe("svc:telegram");
    expect(telegram.origin).toBe("https://api.telegram.org");
  });

  it("puts the token in the URL path, and in no header", () => {
    expect(telegram.upstreamUrl(TG, "/sendMessage", "")).toBe(`https://api.telegram.org/bot${TG}/sendMessage`);
    expect(telegram.upstreamUrl(TG, "/getMe", "?x=1")).toBe(`https://api.telegram.org/bot${TG}/getMe?x=1`);
    expect(JSON.stringify(telegram.authHeaders(TG))).not.toContain(TG);
  });

  it.each([
    ["a slash", "123:abc/../../evil"],
    ["a query", "123:abc?x=1"],
    ["a fragment", "123:abc#x"],
    ["whitespace", "123:abc def"],
    ["no colon", "123abcdefghijklmnopqrstuvwxyz"],
    ["empty", ""],
  ])("never builds a URL from a stored token with %s", (_label, token) => {
    expect(telegram.upstreamUrl(token, "/getMe", "")).toBeNull();
  });

  it("reads rules that name methods, and matches them case-insensitively over GET or POST", () => {
    const rules = ok([{ call: "sendMessage" }, { call: "getMe" }]);
    expect(matchServiceRule(rules, "POST", ["sendMessage"])?.path).toBe("sendMessage");
    expect(matchServiceRule(rules, "GET", ["sendmessage"])?.path).toBe("sendMessage");
    expect(matchServiceRule(rules, "POST", ["SENDMESSAGE"])?.path).toBe("sendMessage");
    expect(matchServiceRule(rules, "GET", ["getMe"])?.method).toBe("CALL");
  });

  it("matches nothing but GET or POST, and nothing deeper than one method name", () => {
    const rules = ok([{ call: "sendMessage" }]);
    for (const method of ["HEAD", "PUT", "PATCH", "DELETE"]) expect(matchServiceRule(rules, method, ["sendMessage"])).toBeNull();
    expect(matchServiceRule(rules, "POST", ["sendMessage", "x"])).toBeNull();
    expect(matchServiceRule(rules, "POST", ["deleteMessage"])).toBeNull();
  });

  it.each([
    ["an HTTP-shaped rule", [{ method: "POST", path: "/sendMessage" }]],
    ["a call with a slash", [{ call: "send/Message" }]],
    ["a call with a wildcard", [{ call: "send*" }]],
    ["an empty call", [{ call: "" }]],
    ["a call that is not a string", [{ call: 7 }]],
    ["an unknown key", [{ call: "getMe", note: "x" }]],
  ])("refuses %s as malformed", (_label, allow) => {
    expect(parseServiceRules({ telegram: { allow } }, "telegram").kind).toBe("malformed");
  });

  it.each(["setWebhook", "deleteWebhook", "logOut", "close", "SETWEBHOOK", "setwebhook"])(
    "refuses %s whatever the rules say",
    (name) => {
      expect(serviceRefusal(telegram, "POST", [name])).not.toBeNull();
      expect(serviceRefusal(telegram, "GET", [name])).not.toBeNull();
    }
  );

  it("refuses file downloads and anything that is not one method name", () => {
    expect(serviceRefusal(telegram, "GET", ["file", "photos", "a.jpg"])).toMatch(/file/i);
    expect(serviceRefusal(telegram, "GET", ["getMe", "x"])).not.toBeNull();
    expect(serviceRefusal(telegram, "POST", ["sendMessage"])).toBeNull();
  });

  it("forwards only content-type from the agent", () => {
    const incoming = new Headers({ "content-type": "application/json", authorization: "Bearer pc_x", accept: "x" });
    expect(Object.fromEntries(filterRequestHeaders(telegram, incoming))).toEqual({ "content-type": "application/json" });
  });
});
