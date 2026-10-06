// "Ask me first" (approvals): the rule flag that asks the owner before a
// service call is sent. Rules are tenant-written and re-validated on every
// read, so the flag is part of the parser's contract: a boolean only, on
// either rule shape, and absent means "do not ask" for every rule written
// before it existed.
import { describe, expect, it } from "vitest";

import { matchServiceRule, parseServiceRules, serviceRulesRevision } from "@/lib/services/rules";

const rulesOf = (raw: unknown, service = "discord") => {
  const parsed = parseServiceRules(raw, service);
  if (parsed.kind !== "rules") throw new Error(`expected rules, got ${JSON.stringify(parsed)}`);
  return parsed.rules;
};

describe("the ask flag on a service rule", () => {
  it("is read on a method-and-path rule", () => {
    const rules = rulesOf({
      discord: { allow: [{ method: "POST", path: "/channels/123/messages", ask: true }] },
    });
    expect(rules.allow[0]!.ask).toBe(true);
    expect(matchServiceRule(rules, "POST", ["channels", "123", "messages"])?.ask).toBe(true);
  });

  it("is read on a call-shaped rule (Telegram)", () => {
    const rules = rulesOf({ telegram: { allow: [{ call: "sendMessage", ask: true }] } }, "telegram");
    expect(rules.allow[0]!.ask).toBe(true);
  });

  it("is false when absent, so every rule written before it keeps working unasked", () => {
    const rules = rulesOf({ discord: { allow: [{ method: "GET", path: "/users/@me" }] } });
    expect(rules.allow[0]!.ask).toBe(false);
    const call = rulesOf({ telegram: { allow: [{ call: "getMe" }] } }, "telegram");
    expect(call.allow[0]!.ask).toBe(false);
  });

  it("accepts an explicit false", () => {
    const rules = rulesOf({ discord: { allow: [{ method: "GET", path: "/users/@me", ask: false }] } });
    expect(rules.allow[0]!.ask).toBe(false);
  });

  it.each([["yes"], [1], [null], [{}]])("makes the rule set malformed for a non-boolean %j", (value) => {
    const parsed = parseServiceRules(
      { discord: { allow: [{ method: "POST", path: "/channels/123/messages", ask: value }] } },
      "discord"
    );
    expect(parsed).toEqual({ kind: "malformed", reason: "ask" });
  });

  it("moves the receipt's policy revision when it is turned on", () => {
    const off = rulesOf({ discord: { allow: [{ method: "POST", path: "/channels/123/messages" }] } });
    const on = rulesOf({ discord: { allow: [{ method: "POST", path: "/channels/123/messages", ask: true }] } });
    expect(serviceRulesRevision("discord", on)).not.toBe(serviceRulesRevision("discord", off));
  });

  it("leaves the revision of a rule set without it unchanged (old receipts keep their pol)", () => {
    const plain = rulesOf({ discord: { allow: [{ method: "POST", path: "/channels/123/messages" }] } });
    const explicitFalse = rulesOf({
      discord: { allow: [{ method: "POST", path: "/channels/123/messages", ask: false }] },
    });
    expect(serviceRulesRevision("discord", explicitFalse)).toBe(serviceRulesRevision("discord", plain));
  });
});

import { composeServiceRules, splitServiceRules } from "@/lib/services/presets";

describe("\"Ask me first\" in the dashboard's simple choices", () => {
  const channel = "123456789012345678";

  it("marks every write the choices produce, and no read", () => {
    const rules = composeServiceRules("discord", { repo: channel, checked: ["read", "send"], extra: [], askWrites: true });
    const send = rules.find((r) => r.method === "POST")!;
    expect(send.ask).toBe(true);
    expect(rules.filter((r) => r.method === "GET").every((r) => !r.ask)).toBe(true);
  });

  it("marks nothing when off, so a saved document is exactly what it was before", () => {
    const rules = composeServiceRules("discord", { repo: channel, checked: ["send"], extra: [], askWrites: false });
    expect(rules.every((r) => !("ask" in r))).toBe(true);
  });

  it("uses each service's own idea of a write: Telegram's non-get methods", () => {
    const rules = composeServiceRules("telegram", {
      repo: null,
      checked: [],
      extra: [
        { method: "CALL", path: "sendMessage" },
        { method: "CALL", path: "getMe" },
      ],
      askWrites: true,
    });
    expect(rules).toEqual([
      { method: "CALL", path: "sendMessage", ask: true },
      { method: "CALL", path: "getMe" },
    ]);
  });

  it("keeps a custom rule's own ask, whatever the switch says", () => {
    const rules = composeServiceRules("discord", {
      repo: null,
      checked: [],
      extra: [{ method: "GET", path: "/v10/users/@me", ask: true }],
      askWrites: false,
    });
    expect(rules).toEqual([{ method: "GET", path: "/v10/users/@me", ask: true }]);
  });

  it("reads the switch back as on when every write asks, and off otherwise", () => {
    const on = composeServiceRules("discord", { repo: channel, checked: ["read", "send"], extra: [], askWrites: true });
    expect(splitServiceRules("discord", on)).toMatchObject({ checked: ["read", "send"], askWrites: true, extra: [] });
    const off = composeServiceRules("discord", { repo: channel, checked: ["read", "send"], extra: [], askWrites: false });
    expect(splitServiceRules("discord", off).askWrites).toBe(false);
    const readOnly = composeServiceRules("discord", { repo: channel, checked: ["read"], extra: [], askWrites: true });
    expect(splitServiceRules("discord", readOnly).askWrites).toBe(false);
  });
});

import { serviceCallAsks } from "@/lib/services/rules";

describe("which rule decides whether a call asks", () => {
  it("asks when ANY rule admitting the call asks, not only the first one listed", () => {
    const rules = rulesOf(
      {
        github: {
          allow: [
            { method: "GET", path: "/repos/acme/web/**" },
            { method: "GET", path: "/repos/acme/web/issues", ask: true },
          ],
        },
      },
      "github"
    );
    // The broad read rule is first, so it is the match; the narrow rule still asks.
    expect(matchServiceRule(rules, "GET", ["repos", "acme", "web", "issues"])?.ask).toBe(false);
    expect(serviceCallAsks(rules, "GET", ["repos", "acme", "web", "issues"])).toBe(true);
    expect(serviceCallAsks(rules, "GET", ["repos", "acme", "web", "pulls"])).toBe(false);
  });

  it("follows the matcher's own rules: HEAD rides on GET, method names in any case", () => {
    const github = rulesOf({ github: { allow: [{ method: "GET", path: "/user", ask: true }] } }, "github");
    expect(serviceCallAsks(github, "HEAD", ["user"])).toBe(true);
    const telegram = rulesOf({ telegram: { allow: [{ call: "sendMessage", ask: true }] } }, "telegram");
    expect(serviceCallAsks(telegram, "POST", ["SENDMESSAGE"])).toBe(true);
  });
});
