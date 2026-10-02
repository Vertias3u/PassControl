// The services-only connect snippets (any-API phase 2, slice B): what an agent
// that calls GitHub or Telegram, and no model, is told to configure. One
// builder for the key reveal and the agent's Setup, so the two cannot drift.
import { describe, expect, it } from "vitest";
import { buildServiceConnectSetup } from "@/lib/service-connect";

describe("buildServiceConnectSetup", () => {
  it("points each service's client at the gateway with the agent's key, never a service token", () => {
    const setup = buildServiceConnectSetup({ origin: "https://gw.example", key: "pc_dak_secret" });
    expect(setup.envBlock).toContain("PASSCONTROL_AGENT_KEY=pc_dak_secret");
    expect(setup.envBlock).toContain("GITHUB_API_URL=https://gw.example/api/v1/svc/github");
    expect(setup.envBlock).toContain("TELEGRAM_API_URL=https://gw.example/api/v1/svc/telegram");
    expect(setup.octokit).toContain('baseUrl: process.env.GITHUB_API_URL');
    expect(setup.octokit).toContain("auth: process.env.PASSCONTROL_AGENT_KEY");
    expect(setup.telegram).toContain("$TELEGRAM_API_URL/getMe");
    expect(setup.telegram).toContain("Bearer $PASSCONTROL_AGENT_KEY");
    // The bot token is the gateway's: the agent's request carries no bot<token> segment.
    expect(setup.telegram).not.toMatch(/\/bot/);
  });

  it("uses a placeholder when the key is not in hand (the agent's Setup)", () => {
    const setup = buildServiceConnectSetup({ origin: "https://gw.example", key: null });
    expect(setup.envBlock).toContain("PASSCONTROL_AGENT_KEY=<this agent's Direct Agent Key>");
  });
});
