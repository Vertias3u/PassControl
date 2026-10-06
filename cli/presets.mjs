import { MCP_INTEGRATIONS } from "./mcp/integration.mjs";

// Single source of truth for the integrations `passcontrol env` and
// `passcontrol configure` accept. Both commands' usage strings are GENERATED
// from these lists rather than typed, because they drifted once already: the
// `configure` usage advertised seven presets while `printAgentPreset` handled
// nine, so `passcontrol configure litellm` worked but was documented as invalid.

/**
 * Clients configured by typing a base URL into a settings form rather than by
 * exporting environment variables. They all take the same three fields, so the
 * value here is the display name — the preset body is identical for every one.
 *
 * These are the desktop chat apps people already keep their raw provider key
 * in. Pointing one at the sidecar means the app holds a passport-minted visa
 * instead, and never sees the key.
 */
export const GUI_PRESET_LABELS = {
  cline: "Cline",
  continue: "Continue",
  chatbox: "Chatbox",
  jan: "Jan",
  msty: "Msty",
  "cherry-studio": "Cherry Studio",
  "open-webui": "Open WebUI",
  librechat: "LibreChat",
};

export function isGuiPreset(name) {
  return Object.hasOwn(GUI_PRESET_LABELS, String(name ?? "").toLowerCase());
}

/**
 * Non-LLM APIs a client can be pointed at through the sidecar (any-API). The
 * preset prints the governed base URL for that service; what the agent may call
 * there is set per agent in the dashboard.
 */
export const SERVICE_PRESETS = ["github", "telegram", "brave", "notion", "discord"];

/**
 * What `passcontrol env <service>` prints for each: the variable (the same one
 * the dashboard's Setup names, lib/services/display.ts), two lines on where the
 * agent's access is set, and one usage hint. Pinned to the catalog by
 * tests/cli-service-presets.test.ts.
 */
export const SERVICE_ENV = {
  github: {
    label: "GitHub",
    envVar: "GITHUB_API_URL",
    about: [
      "# GitHub REST through PassControl. What this agent may do is set on its page in the",
      "# dashboard, under GitHub access; the workspace's GitHub token stays in PassControl.",
    ],
    usage: "# Octokit: new Octokit({ baseUrl: process.env.GITHUB_API_URL }) — and no auth option.",
  },
  telegram: {
    label: "Telegram",
    envVar: "TELEGRAM_API_URL",
    about: [
      "# Telegram Bot API through PassControl. What this agent may do is set on its page in the",
      "# dashboard, under Telegram access; the bot token stays in PassControl.",
    ],
    usage: '# Call a method by name, with no token in the URL: curl "$TELEGRAM_API_URL/getMe"',
  },
  brave: {
    label: "Brave Search",
    envVar: "BRAVE_SEARCH_API_URL",
    about: [
      "# Brave Search through PassControl. What this agent may search is set on its page in the",
      "# dashboard, under Brave Search access; the API key stays in PassControl. Brave bills per search.",
    ],
    usage: '# Search with no key header: curl "$BRAVE_SEARCH_API_URL/web/search?q=passcontrol"',
  },
  notion: {
    label: "Notion",
    envVar: "NOTION_API_URL",
    about: [
      "# Notion through PassControl. What this agent may do is set on its page in the dashboard,",
      "# under Notion access; the integration token stays in PassControl.",
    ],
    usage: "# @notionhq/client: new Client({ baseUrl: process.env.NOTION_API_URL }) — and no auth option.",
  },
  discord: {
    label: "Discord",
    envVar: "DISCORD_API_URL",
    about: [
      "# Discord's bot API through PassControl. What this agent may do is set on its page in the",
      "# dashboard, under Discord access; the bot token stays in PassControl.",
    ],
    usage: '# discord.js: new REST({ api: process.env.DISCORD_API_URL, version: "10" }).setToken("sidecar") — any token; the sidecar replaces it.',
  },
};

export function isServicePreset(name) {
  return SERVICE_PRESETS.includes(String(name ?? "").toLowerCase());
}

/** Presets that print settings pointing an agent at the local sidecar bridge. */
export const SIDECAR_PRESETS = [
  "generic",
  "openhands",
  "litellm",
  "aider",
  "hermes",
  ...Object.keys(GUI_PRESET_LABELS),
  ...SERVICE_PRESETS,
];

/** MCP client targets. Shares the set the MCP config writer dispatches on. */
export const MCP_PRESETS = [...MCP_INTEGRATIONS];

/** Everything both commands accept. */
export const INTEGRATIONS = [...SIDECAR_PRESETS, ...MCP_PRESETS];

/**
 * Integrations where `configure --write` actually writes a file. Everything else
 * is UI- or project-schema-specific (or, for claude-code, owned by that client's
 * own CLI), so `--write` is refused with the real instruction instead of being
 * accepted and silently doing nothing.
 */
export const WRITABLE_INTEGRATIONS = ["aider", "claude-desktop", "cursor"];

export function isIntegration(name) {
  return INTEGRATIONS.includes(String(name ?? "").toLowerCase());
}

export function supportsWrite(name) {
  return WRITABLE_INTEGRATIONS.includes(String(name ?? "").toLowerCase());
}

/** `generic|openhands|…` — for usage strings, so they can never drift again. */
export function integrationChoices() {
  return INTEGRATIONS.join("|");
}
