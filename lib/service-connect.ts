// What an agent that calls services (every catalog service) and no model is told to
// configure. One builder for the Direct Agent Key reveal and the agent's Setup
// panel, so the two cannot disagree on URLs or headers (the same reason
// lib/direct-connect-config.ts exists for model calls).
//
// The agent holds only its PassControl key. The GitHub token and the bot token
// stay in the gateway, which is why the Telegram example names a method and
// carries no `bot<token>` segment.
import { DISPLAYED_SERVICES, SERVICE_DISPLAY } from "@/lib/services/display";

export interface ServiceConnectSetup {
  envBlock: string;
  octokit: string;
  telegram: string;
}

const KEY_PLACEHOLDER = "<this agent's Direct Agent Key>";

export function buildServiceConnectSetup({ origin, key }: { origin: string; key: string | null }): ServiceConnectSetup {
  const base = `${origin.replace(/\/+$/u, "")}/api/v1/svc`;
  return {
    envBlock: [
      `PASSCONTROL_AGENT_KEY=${key ?? KEY_PLACEHOLDER}`,
      ...DISPLAYED_SERVICES.map((service) => `${SERVICE_DISPLAY[service].envVar}=${base}/${service}`),
    ].join("\n"),
    octokit: [
      'import { Octokit } from "octokit";',
      "",
      "const octokit = new Octokit({",
      "  baseUrl: process.env.GITHUB_API_URL,",
      "  auth: process.env.PASSCONTROL_AGENT_KEY, // the agent's key, not a GitHub token",
      "});",
      'const { data } = await octokit.rest.users.getAuthenticated();',
    ].join("\n"),
    telegram: [
      "# A Bot API method by name; the gateway adds the bot token.",
      'curl -s "$TELEGRAM_API_URL/getMe" -H "Authorization: Bearer $PASSCONTROL_AGENT_KEY"',
    ].join("\n"),
  };
}
