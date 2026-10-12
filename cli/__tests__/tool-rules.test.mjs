import { describe, expect, it } from "vitest";
import { evaluateToolRules, globMatch, parseToolRules, TOOL_RULE_LIMITS } from "../tool-rules.mjs";

const parsed = (rules, extra = {}) => {
  const out = parseToolRules({ rules, ...extra });
  if (!out?.ok) throw new Error("expected valid rules");
  return out;
};
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

describe("globMatch", () => {
  it("treats * as any run of characters and everything else literally", () => {
    expect(globMatch("git push*", "git push --force origin main")).toBe(true);
    expect(globMatch("git push*", "git pull")).toBe(false);
    expect(globMatch("*.env", "/repo/.env")).toBe(true);
    expect(globMatch("/etc/*", "/etc/ssh/sshd_config")).toBe(true);
    expect(globMatch("a*b*c", "aXXbYYc")).toBe(true);
    expect(globMatch("a*b*c", "aXXcYYb")).toBe(false);
    expect(globMatch("rm -rf .", "rm -rf ..")).toBe(false);
    expect(globMatch("[a]?(x)", "[a]?(x)")).toBe(true);
    expect(globMatch("*", "")).toBe(true);
  });

  it("costs a native string search, never backtracking, on a long input", () => {
    const input = "a".repeat(1_000_000);
    const started = performance.now();
    expect(globMatch(`*${"a*".repeat(50)}b`, input)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("parseToolRules", () => {
  it("reads no rules as no rules", () => {
    expect(parseToolRules(null)).toEqual({ ok: true, rules: [], approvalWaitS: 120 });
  });

  it("accepts each condition on the tools it belongs to", () => {
    const out = parseToolRules({
      rules: [
        { tool: "Bash", command: "git push*", effect: "ask_owner" },
        { tool: "Write", path: "/etc/*", effect: "deny" },
        { tool: "WebFetch", domain: "*.example.com", effect: "ask" },
        { tool: "mcp__github__*", effect: "ask_owner" },
        { tool: "Task", effect: "ask" },
      ],
      approval_wait_s: 300,
    });
    expect(out).toMatchObject({ ok: true, approvalWaitS: 300 });
    expect(out.rules).toHaveLength(5);
  });

  it.each([
    ["not an object", 5],
    ["rules not a list", { rules: {} }],
    ["an unknown key", { rules: [], allow: [] }],
    ["an unknown rule key", { rules: [{ tool: "Bash", effect: "deny", why: "x" }] }],
    ["an unknown effect", { rules: [{ tool: "Bash", effect: "allow" }] }],
    ["a command on another tool", { rules: [{ tool: "Read", command: "x", effect: "deny" }] }],
    ["a path on Bash", { rules: [{ tool: "Bash", path: "/x", effect: "deny" }] }],
    ["a domain on Bash", { rules: [{ tool: "Bash", domain: "x.com", effect: "deny" }] }],
    ["two conditions", { rules: [{ tool: "Bash", command: "x", path: "/x", effect: "deny" }] }],
    ["a condition with a wildcard tool", { rules: [{ tool: "B*", command: "x", effect: "deny" }] }],
    ["a star inside a tool name", { rules: [{ tool: "mcp__*__x", effect: "deny" }] }],
    ["an empty pattern", { rules: [{ tool: "Bash", command: "", effect: "deny" }] }],
    ["a relative path pattern", { rules: [{ tool: "Write", path: "src/*", effect: "deny" }] }],
    ["a domain with a path", { rules: [{ tool: "WebFetch", domain: "x.com/a", effect: "deny" }] }],
    ["a wait too short", { rules: [], approval_wait_s: 5 }],
    ["a wait past the hook's limit", { rules: [], approval_wait_s: 541 }],
    ["too many rules", { rules: Array.from({ length: TOOL_RULE_LIMITS.rules + 1 }, () => ({ tool: "Bash", effect: "ask" })) }],
    ["a pattern too long", { rules: [{ tool: "Bash", command: "x".repeat(TOOL_RULE_LIMITS.patternLen + 1), effect: "deny" }] }],
  ])("refuses the whole document with %s", (_why, value) => {
    expect(parseToolRules(value)).toEqual({ ok: false });
  });
});

describe("evaluateToolRules", () => {
  it("lets through what no rule names", () => {
    expect(evaluateToolRules(parsed([{ tool: "Bash", command: "git push*", effect: "deny" }]), bash("git status"))).toEqual({
      effect: null,
    });
  });

  it("checks each piece of a chained command", () => {
    const rules = parsed([{ tool: "Bash", command: "git push*", effect: "ask_owner" }]);
    for (const command of ["cd repo && git push", "make; git push origin", "false || git push", "echo x | git push", "ls\ngit push"]) {
      expect(evaluateToolRules(rules, bash(command))).toMatchObject({ effect: "ask_owner", ruleIndex: 0, subject: "git push" + command.split("git push")[1] });
    }
  });

  it("lets the strictest matching rule win, whatever the order", () => {
    const rules = parsed([
      { tool: "Bash", effect: "ask" },
      { tool: "Bash", command: "rm *", effect: "deny" },
      { tool: "Bash", command: "rm -rf *", effect: "ask_owner" },
    ]);
    expect(evaluateToolRules(rules, bash("rm -rf build"))).toMatchObject({ effect: "deny", ruleIndex: 1 });
    expect(evaluateToolRules(rules, bash("ls"))).toMatchObject({ effect: "ask", ruleIndex: 0 });
  });

  it("matches a file tool on its absolute path, normalised", () => {
    const rules = parsed([{ tool: "Write", path: "/etc/*", effect: "deny" }]);
    const write = (file_path) => ({ tool_name: "Write", tool_input: { file_path, content: "x" } });
    expect(evaluateToolRules(rules, write("/etc/hosts"))).toMatchObject({ effect: "deny", subject: "/etc/hosts" });
    expect(evaluateToolRules(rules, write("/home/u/../../etc/hosts"))).toMatchObject({ effect: "deny", subject: "/etc/hosts" });
    expect(evaluateToolRules(rules, write("/home/u/./etc/hosts"))).toEqual({ effect: null });
    const win = parsed([{ tool: "Write", path: "C:/Windows/*", effect: "deny" }]);
    expect(evaluateToolRules(win, write("C:\\Windows\\system32\\x.dll"))).toMatchObject({ effect: "deny" });
  });

  it("reads NotebookEdit's notebook_path, and a search tool's path or the session's directory", () => {
    const rules = parsed([
      { tool: "NotebookEdit", path: "/secret/*", effect: "deny" },
      { tool: "Grep", path: "/secret*", effect: "deny" },
    ]);
    expect(evaluateToolRules(rules, { tool_name: "NotebookEdit", tool_input: { notebook_path: "/secret/a.ipynb" } })).toMatchObject({ effect: "deny" });
    expect(evaluateToolRules(rules, { tool_name: "Grep", tool_input: { pattern: "x" }, cwd: "/secret" })).toMatchObject({ effect: "deny" });
    expect(evaluateToolRules(rules, { tool_name: "Grep", tool_input: { pattern: "x", path: "/public" }, cwd: "/secret" })).toEqual({ effect: null });
  });

  it("matches WebFetch on the host, with *. covering the domain and its subdomains", () => {
    const rules = parsed([{ tool: "WebFetch", domain: "*.example.com", effect: "ask" }]);
    const fetch = (url) => ({ tool_name: "WebFetch", tool_input: { url, prompt: "x" } });
    expect(evaluateToolRules(rules, fetch("https://api.Example.com/x"))).toMatchObject({ effect: "ask", subject: "api.example.com" });
    expect(evaluateToolRules(rules, fetch("https://example.com/"))).toMatchObject({ effect: "ask" });
    expect(evaluateToolRules(rules, fetch("https://notexample.com/"))).toEqual({ effect: null });
    expect(evaluateToolRules(rules, fetch("https://example.com.evil.net/"))).toEqual({ effect: null });
  });

  it("names tools exactly or by a trailing *", () => {
    const rules = parsed([{ tool: "mcp__github__*", effect: "ask_owner" }]);
    expect(evaluateToolRules(rules, { tool_name: "mcp__github__create_issue", tool_input: {} })).toMatchObject({ effect: "ask_owner", subject: "mcp__github__create_issue" });
    expect(evaluateToolRules(rules, { tool_name: "mcp__gitlab__x", tool_input: {} })).toEqual({ effect: null });
  });

  it("treats input it cannot read as matching a rule that needs it, not as a pass", () => {
    const rules = parsed([
      { tool: "Bash", command: "git push*", effect: "deny" },
      { tool: "WebFetch", domain: "x.com", effect: "deny" },
    ]);
    expect(evaluateToolRules(rules, { tool_name: "Bash", tool_input: {} })).toMatchObject({ effect: "deny" });
    expect(evaluateToolRules(rules, { tool_name: "WebFetch", tool_input: { url: "not a url" } })).toMatchObject({ effect: "deny" });
  });
});
