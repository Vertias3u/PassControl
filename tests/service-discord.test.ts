// Discord (bot) in the any-API catalog (plans/any-api-credentials.md §13, S3).
// The never list below was written from Discord's own route tables
// (docs.discord.com/developers/resources/*.md, read 2026-10-05), not from memory.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SERVICE_CATALOG, isServiceId, serviceRefusal } from "@/lib/services/catalog";
import { presetScopeFor, splitServiceRules, composeServiceRules } from "@/lib/services/presets";

// Discord's documentation example token, split so secret scanners do not block a push over it.
const TOKEN = ["MTk4NjIyNDgzNDcxOTI1MjQ4", "Cl2FMQ", "ZnCjm1XVW7vRze4b7Cq4se7kKWs"].join(".");
const discord = SERVICE_CATALOG.discord;
const seg = (path: string) => path.replace(/^\//u, "").split("/");
const refuse = (method: string, path: string) => serviceRefusal(discord, method, seg(path));
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

describe("Discord's catalog entry", () => {
  it("is a catalog service with its own credential namespace", () => {
    expect(isServiceId("discord")).toBe(true);
    expect(discord.credentialProvider).toBe("svc:discord");
    expect(discord.label).toBe("Discord");
  });

  it("sends /api plus the agent's versioned path, as discord.js builds it", () => {
    expect(discord.upstreamUrl(TOKEN, "/v10/channels/1/messages", "?limit=5")).toBe(
      "https://discord.com/api/v10/channels/1/messages?limit=5"
    );
  });

  it("refuses any version but v10: an unversioned path would reach Discord's default, v6", () => {
    expect(refuse("GET", "/channels/1/messages")).toMatch(/v10/);
    expect(refuse("GET", "/v9/channels/1/messages")).toMatch(/v10/);
    expect(refuse("GET", "/v10/channels/1/messages")).toBeNull();
  });

  it("authenticates as a bot with a User-Agent Discord requires, naming this release", () => {
    const headers = discord.authHeaders(TOKEN);
    expect(headers.authorization).toBe(`Bot ${TOKEN}`);
    expect(headers["user-agent"]).toBe(`DiscordBot (https://github.com/Vertias3u/PassControl, ${pkg.version})`);
    expect(discord.tokenShape?.test(TOKEN)).toBe(true);
    expect(discord.tokenShape?.test("abc\r\nx-evil: 1")).toBe(false);
  });

  // Every webhook route, reads too: "Get Channel Webhooks" and friends return
  // each webhook's token, a credential to post as it.
  it.each([
    ["GET", "/v10/channels/1/webhooks"],
    ["POST", "/v10/channels/1/webhooks"],
    ["GET", "/v10/guilds/1/webhooks"],
    ["GET", "/v10/webhooks/1"],
    ["GET", "/v10/webhooks/1/tok"],
    ["POST", "/v10/webhooks/1/tok"],
    ["DELETE", "/v10/webhooks/1"],
    ["POST", "/v10/interactions/1/tok/callback"],
    ["GET", "/v10/oauth2/@me"],
  ])("refuses %s %s, reads included", (method, path) => {
    expect(refuse(method, path)).not.toBeNull();
  });

  it.each([
    ["PATCH", "/v10/guilds/1"],
    ["DELETE", "/v10/guilds/1"],
    ["POST", "/v10/guilds"],
    ["POST", "/v10/guilds/1/roles"],
    ["PATCH", "/v10/guilds/1/roles"],
    ["PATCH", "/v10/guilds/1/roles/2"],
    ["DELETE", "/v10/guilds/1/roles/2"],
    ["PUT", "/v10/guilds/1/members/2/roles/3"],
    ["DELETE", "/v10/guilds/1/members/2/roles/3"],
    ["PATCH", "/v10/guilds/1/members/2"],
    ["PUT", "/v10/guilds/1/members/2"],
    ["DELETE", "/v10/guilds/1/members/2"],
    ["PUT", "/v10/guilds/1/bans/2"],
    ["DELETE", "/v10/guilds/1/bans/2"],
    ["POST", "/v10/guilds/1/bulk-ban"],
    ["POST", "/v10/guilds/1/prune"],
    ["PUT", "/v10/guilds/1/incident-actions"],
    ["PUT", "/v10/guilds/1/onboarding"],
    ["PATCH", "/v10/guilds/1/welcome-screen"],
    ["PATCH", "/v10/guilds/1/widget"],
    ["POST", "/v10/guilds/1/auto-moderation/rules"],
    ["PATCH", "/v10/guilds/1/auto-moderation/rules/2"],
    ["DELETE", "/v10/guilds/1/integrations/2"],
    ["POST", "/v10/guilds/1/channels"],
    ["PATCH", "/v10/guilds/1/channels"],
    ["PATCH", "/v10/channels/1"],
    ["DELETE", "/v10/channels/1"],
    ["PUT", "/v10/channels/1/permissions/2"],
    ["DELETE", "/v10/channels/1/permissions/2"],
    ["POST", "/v10/channels/1/invites"],
    ["POST", "/v10/channels/1/messages/bulk-delete"],
    ["PUT", "/v10/channels/1/recipients/2"],
    ["POST", "/v10/channels/1/followers"],
    ["DELETE", "/v10/invites/abc"],
    ["PUT", "/v10/invites/abc/target-users"],
    ["PATCH", "/v10/users/@me"],
    ["DELETE", "/v10/users/@me/guilds/1"],
    ["PUT", "/v10/users/@me/applications/1/role-connection"],
    ["PATCH", "/v10/applications/@me"],
    ["PUT", "/v10/applications/1/commands"],
    ["POST", "/v10/applications/1/entitlements"],
    ["POST", "/v10/lobbies"],
    ["patch", "/V10/GUILDS/1"],
    // Only the bot's own member record and nickname stay with the rules: not
    // anything under them (a bot must not grant itself a role).
    ["PUT", "/v10/guilds/1/members/@me/roles/2"],
    ["DELETE", "/v10/guilds/1/members/@me/roles/2"],
    ["PATCH", "/v10/guilds/1/members/@me/anything"],
    // Templates (guild-template route table) and voice states (voice).
    ["POST", "/v10/guilds/1/templates"],
    ["PUT", "/v10/guilds/1/templates/abc"],
    ["PATCH", "/v10/guilds/1/templates/abc"],
    ["DELETE", "/v10/guilds/1/templates/abc"],
    ["POST", "/v10/guilds/templates/abc"],
    ["PATCH", "/v10/guilds/1/voice-states/2"],
    ["PATCH", "/v10/guilds/1/voice-states/@me"],
  ])("refuses the write %s %s whatever the rules say", (method, path) => {
    expect(refuse(method, path)).not.toBeNull();
  });

  it.each([
    ["GET", "/v10/channels/1"],
    ["GET", "/v10/channels/1/messages"],
    ["POST", "/v10/channels/1/messages"],
    ["PATCH", "/v10/channels/1/messages/2"],
    ["DELETE", "/v10/channels/1/messages/2"],
    ["PUT", "/v10/channels/1/messages/2/reactions/%F0%9F%91%8D/@me"],
    ["POST", "/v10/channels/1/threads"],
    ["POST", "/v10/channels/1/typing"],
    ["GET", "/v10/guilds/1/members"],
    ["GET", "/v10/guilds/1/roles"],
    ["PATCH", "/v10/guilds/1/members/@me/nick"],
    ["PATCH", "/v10/guilds/1/members/@me"],
    ["POST", "/v10/users/@me/channels"],
  ])("leaves %s %s to the agent's rules", (method, path) => {
    expect(refuse(method, path)).toBeNull();
  });

  it("counts every non-GET rule as a write", () => {
    expect(discord.isWriteRule({ method: "GET", path: "/v10/channels/*/messages" })).toBe(false);
    expect(discord.isWriteRule({ method: "POST", path: "/v10/channels/*/messages" })).toBe(true);
  });
});

describe("Discord's preset scope: one channel", () => {
  const scope = presetScopeFor("discord")!;

  it("reads a channel id, or a channel link", () => {
    expect(scope.parse(" 123456789012345678 ")).toBe("123456789012345678");
    expect(scope.parse("https://discord.com/channels/111111111111111111/123456789012345678")).toBe("123456789012345678");
    expect(scope.parse("general")).toBeNull();
    expect(scope.parse("123")).toBeNull();
    expect(scope.parse("https://evil.example/channels/1/123456789012345678")).toBeNull();
  });

  it("writes channel-scoped rules and reads them back", () => {
    const channel = "123456789012345678";
    const rules = composeServiceRules("discord", { repo: channel, checked: ["read", "send"], extra: [] });
    expect(rules).toContainEqual({ method: "POST", path: `/v10/channels/${channel}/messages` });
    expect(rules).toContainEqual({ method: "GET", path: `/v10/channels/${channel}/messages` });
    expect(splitServiceRules("discord", rules)).toMatchObject({ repo: channel, checked: ["read", "send"], extra: [] });
  });
});
