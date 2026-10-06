// Plain-language service access (the agent page's simple mode).
//
// A preset is only a way of writing rules: what is saved is the same rule list
// an operator could have typed, checked by the same parser, enforced by the same
// matcher. These tests pin the three things that could quietly widen or lose
// access: the rules each choice writes, that a saved list reads back as the
// choices that wrote it, and that anything a choice did not write survives as a
// custom rule rather than being dropped on the next save.
import { describe, expect, it } from "vitest";
import {
  GITHUB_PRESETS,
  TELEGRAM_PRESETS,
  composeServiceRules,
  normalizeRulePath,
  parseRepoInput,
  splitServiceRules,
} from "@/lib/services/presets";
import { matchServiceRule, parseServiceRules } from "@/lib/services/rules";
import { serviceRefusal, SERVICE_CATALOG } from "@/lib/services/catalog";

const REPO = "Vertias3u/testrepo1345";

const toStored = (service: "github" | "telegram", allow: { method: string; path: string }[]) => ({
  [service]: {
    allow: allow.map((rule) => (service === "telegram" ? { call: rule.path } : { method: rule.method, path: rule.path })),
  },
});

describe("parseRepoInput", () => {
  it("takes owner/name as typed, keeping its case (rule matching is case-sensitive)", () => {
    expect(parseRepoInput("Vertias3u/testrepo1345")).toBe(REPO);
    expect(parseRepoInput("  acme/Web.App_2  ")).toBe("acme/Web.App_2");
  });

  it("takes a github.com link, with or without .git and trailing paths", () => {
    expect(parseRepoInput("https://github.com/Vertias3u/testrepo1345")).toBe(REPO);
    expect(parseRepoInput("https://github.com/Vertias3u/testrepo1345.git")).toBe(REPO);
    expect(parseRepoInput("github.com/Vertias3u/testrepo1345/issues/1")).toBe(REPO);
  });

  it("refuses anything that is not one repository", () => {
    for (const bad of ["", "acme", "acme/", "/web", "acme/web/extra", "acme/*", "acme/**", "a b/c", "acme/..", "https://gitlab.com/a/b"]) {
      expect(parseRepoInput(bad), bad).toBeNull();
    }
  });
});

describe("the rules each GitHub choice writes", () => {
  const rulesOf = (id: string) => GITHUB_PRESETS.find((preset) => preset.id === id)!.rules(REPO);

  it("read says it is every read the token allows, since the never list does not apply to reads", () => {
    expect(GITHUB_PRESETS.find((preset) => preset.id === "read")!.hint).toMatch(/Every read the token allows/);
  });

  it("read covers the repository itself as well as everything under it", () => {
    expect(rulesOf("read")).toEqual([
      { method: "GET", path: `/repos/${REPO}` },
      { method: "GET", path: `/repos/${REPO}/**` },
    ]);
  });

  it("each write choice names exactly one path, with no ** (the parser refuses ** on writes)", () => {
    expect(rulesOf("issues")).toEqual([{ method: "POST", path: `/repos/${REPO}/issues` }]);
    expect(rulesOf("comment")).toEqual([{ method: "POST", path: `/repos/${REPO}/issues/*/comments` }]);
    expect(rulesOf("pulls")).toEqual([{ method: "POST", path: `/repos/${REPO}/pulls` }]);
  });

  it("every choice is a valid rule set that the never list does not block", () => {
    for (const preset of GITHUB_PRESETS) {
      const allow = preset.rules(REPO);
      const parsed = parseServiceRules(toStored("github", allow), "github");
      expect(parsed.kind, preset.id).toBe("rules");
      for (const rule of allow) {
        const segments = rule.path.slice(1).split("/").map((s) => (s === "*" || s === "**" ? "1" : s));
        expect(serviceRefusal(SERVICE_CATALOG.github, rule.method, segments), `${preset.id} ${rule.path}`).toBeNull();
      }
    }
  });

  it("read admits the repository and its issues, and no write", () => {
    const parsed = parseServiceRules(toStored("github", rulesOf("read")), "github");
    if (parsed.kind !== "rules") throw new Error("not rules");
    const seg = (p: string) => p.slice(1).split("/");
    expect(matchServiceRule(parsed.rules, "GET", seg(`/repos/${REPO}`))).not.toBeNull();
    expect(matchServiceRule(parsed.rules, "GET", seg(`/repos/${REPO}/issues`))).not.toBeNull();
    expect(matchServiceRule(parsed.rules, "POST", seg(`/repos/${REPO}/issues`))).toBeNull();
    expect(matchServiceRule(parsed.rules, "GET", seg("/repos/Vertias3u/other"))).toBeNull();
  });
});

describe("the rules each Telegram choice writes", () => {
  const rulesOf = (id: string) => TELEGRAM_PRESETS.find((preset) => preset.id === id)!.rules();

  it("read is getMe and getUpdates; send is sendMessage", () => {
    expect(rulesOf("read")).toEqual([
      { method: "CALL", path: "getMe" },
      { method: "CALL", path: "getUpdates" },
    ]);
    expect(rulesOf("send")).toEqual([{ method: "CALL", path: "sendMessage" }]);
  });

  it("every choice parses as call rules", () => {
    for (const preset of TELEGRAM_PRESETS) {
      expect(parseServiceRules(toStored("telegram", preset.rules()), "telegram").kind, preset.id).toBe("rules");
    }
  });
});

describe("composeServiceRules", () => {
  it("writes the chosen presets for the repository, then the custom rules, without duplicates", () => {
    const allow = composeServiceRules("github", {
      repo: REPO,
      checked: ["read", "issues"],
      extra: [
        { method: "GET", path: `/repos/${REPO}` }, // already written by read
        { method: "GET", path: "/user/repos" },
      ],
    });
    expect(allow).toEqual([
      { method: "GET", path: `/repos/${REPO}` },
      { method: "GET", path: `/repos/${REPO}/**` },
      { method: "POST", path: `/repos/${REPO}/issues` },
      { method: "GET", path: "/user/repos" },
    ]);
  });

  it("writes no preset rule without a repository", () => {
    expect(composeServiceRules("github", { repo: null, checked: ["read"], extra: [] })).toEqual([]);
  });

  it("gives a custom path its missing leading slash", () => {
    expect(composeServiceRules("github", { repo: null, checked: [], extra: [{ method: "GET", path: "repos/a/b" }] })).toEqual([
      { method: "GET", path: "/repos/a/b" },
    ]);
  });

  it("dedupes Telegram methods in any case", () => {
    expect(
      composeServiceRules("telegram", { repo: null, checked: ["read"], extra: [{ method: "CALL", path: "GETME" }] })
    ).toEqual([
      { method: "CALL", path: "getMe" },
      { method: "CALL", path: "getUpdates" },
    ]);
  });
});

describe("splitServiceRules (reading a saved list back as choices)", () => {
  it("reads back exactly the choices that wrote a list", () => {
    const allow = composeServiceRules("github", { repo: REPO, checked: ["read", "comment"], extra: [] });
    expect(splitServiceRules("github", allow)).toEqual({ repo: REPO, checked: ["read", "comment"], extra: [], askWrites: false });
  });

  it("keeps every rule no choice wrote as a custom rule, so a save never drops it", () => {
    const allow = [
      { method: "GET", path: `/repos/${REPO}/**` }, // half of read: not the read choice
      { method: "POST", path: `/repos/${REPO}/issues` },
      { method: "PUT", path: `/repos/${REPO}/contents/README.md` },
    ];
    const split = splitServiceRules("github", allow);
    expect(split.repo).toBe(REPO);
    expect(split.checked).toEqual(["issues"]);
    expect(split.extra).toEqual([
      { method: "GET", path: `/repos/${REPO}/**` },
      { method: "PUT", path: `/repos/${REPO}/contents/README.md` },
    ]);
    // Round trip: saving what was read writes the same rules back.
    expect(new Set(composeServiceRules("github", split).map((r) => `${r.method} ${r.path}`))).toEqual(
      new Set(allow.map((r) => `${r.method} ${r.path}`))
    );
  });

  it("does not treat a rule for another repository as a choice", () => {
    const allow = [
      ...composeServiceRules("github", { repo: REPO, checked: ["read"], extra: [] }),
      { method: "POST", path: "/repos/acme/web/issues" },
    ];
    const split = splitServiceRules("github", allow);
    expect(split).toEqual({ repo: REPO, checked: ["read"], extra: [{ method: "POST", path: "/repos/acme/web/issues" }], askWrites: false });
  });

  it("suggests the repository of a list with no complete choice when it names only one", () => {
    expect(splitServiceRules("github", [{ method: "GET", path: `/repos/${REPO}/**` }]).repo).toBe(REPO);
    expect(splitServiceRules("github", [{ method: "GET", path: "/user" }]).repo).toBeNull();
  });

  it("reads Telegram methods back in any case", () => {
    expect(
      splitServiceRules("telegram", [
        { method: "CALL", path: "getupdates" },
        { method: "CALL", path: "GetMe" },
        { method: "CALL", path: "sendPhoto" },
      ])
    ).toEqual({ repo: null, checked: ["read"], extra: [{ method: "CALL", path: "sendPhoto" }], askWrites: false });
  });
});

describe("normalizeRulePath", () => {
  it("adds the leading slash an HTTP rule needs, and leaves a method name alone", () => {
    expect(normalizeRulePath("http", " repos/a/b ")).toBe("/repos/a/b");
    expect(normalizeRulePath("http", "/repos/a/b")).toBe("/repos/a/b");
    expect(normalizeRulePath("http", "")).toBe("");
    expect(normalizeRulePath("call", " sendMessage ")).toBe("sendMessage");
  });
});
