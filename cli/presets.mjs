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

/** Presets that print settings pointing an agent at the local sidecar bridge. */
export const SIDECAR_PRESETS = [
  "generic",
  "openhands",
  "litellm",
  "aider",
  ...Object.keys(GUI_PRESET_LABELS),
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
