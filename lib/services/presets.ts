// Plain-language service access: the agent page's checkboxes.
//
// A preset is only a way of WRITING rules. What gets saved is the same rule
// list an operator could have typed into the custom-rule editor, validated by
// the gateway's own parser in setAgentServiceRules and enforced by the same
// matcher, with the never list still applied to every call. Nothing here is
// consulted by the gateway.
//
// Reading back has one duty: never lose a rule. A saved list is split into the
// choices it fully contains and everything else, and everything else comes back
// as a custom rule, so saving the form again writes the same rules.
import { SERVICE_CATALOG, isServiceId, ruleShapeFor, type ServiceId } from "./catalog";
import { parseServiceRules } from "./rules";

export interface PresetRule {
  method: string;
  path: string;
  /** "Ask me first" on this one rule (lib/services/rules.ts). Present only when true. */
  ask?: boolean;
}

export interface ServicePreset {
  id: string;
  label: string;
  /** One line under the choice, when its reach is not obvious from the label. */
  hint?: string;
  /**
   * For a scoped service, the scope (a GitHub repository as `owner/name`); ignored
   * otherwise. See `presetScopeFor`.
   */
  rules(repo?: string): PresetRule[];
}

export const GITHUB_PRESETS: readonly ServicePreset[] = [
  {
    id: "read",
    label: "Read code, issues and pull requests",
    // Said plainly because the label alone undersells it: the never list does
    // not apply to reads, so this is every read the token allows in the repository.
    hint: "Every read the token allows in this repository, not only these: with a broad token that includes Actions logs and settings. Limit the token to limit this.",
    // `/**` matches one or more segments, so the repository itself needs its own rule.
    rules: (repo) => [
      { method: "GET", path: `/repos/${repo}` },
      { method: "GET", path: `/repos/${repo}/**` },
    ],
  },
  { id: "issues", label: "Open issues", rules: (repo) => [{ method: "POST", path: `/repos/${repo}/issues` }] },
  {
    id: "comment",
    // A pull request's conversation comments go through the issues endpoint.
    label: "Comment on issues and pull requests",
    rules: (repo) => [{ method: "POST", path: `/repos/${repo}/issues/*/comments` }],
  },
  { id: "pulls", label: "Open pull requests", rules: (repo) => [{ method: "POST", path: `/repos/${repo}/pulls` }] },
];

export const TELEGRAM_PRESETS: readonly ServicePreset[] = [
  {
    id: "read",
    label: "Read messages sent to the bot",
    hint: "Agents that share this bot share one queue of updates.",
    rules: () => [
      { method: "CALL", path: "getMe" },
      { method: "CALL", path: "getUpdates" },
    ],
  },
  {
    id: "send",
    label: "Send messages",
    hint: "Reaches any chat the bot is in: the chat is chosen in each request, not here.",
    rules: () => [{ method: "CALL", path: "sendMessage" }],
  },
];

// Only endpoints confirmed on Brave's own documentation (plans/any-api-
// credentials.md §13); others can still be written as custom rules.
export const BRAVE_PRESETS: readonly ServicePreset[] = [
  { id: "web", label: "Search the web", rules: () => [{ method: "GET", path: "/web/search" }] },
  {
    id: "llm-context",
    label: "Fetch search context for a model",
    hint: "Brave's LLM context endpoint: search results shaped for a prompt.",
    rules: () => [{ method: "GET", path: "/llm/context" }],
  },
  {
    id: "local",
    label: "Look up local places",
    rules: () => [
      { method: "GET", path: "/local/pois" },
      { method: "GET", path: "/local/descriptions" },
    ],
  },
];

// Notion's reach is set in Notion (the pages shared with the integration), so
// these take no scope here. Paths keep /v1, as Notion's SDK sends them.
export const NOTION_PRESETS: readonly ServicePreset[] = [
  {
    id: "read",
    label: "Search and read pages and databases",
    hint: "Every page and database shared with the integration in Notion.",
    rules: () => [
      { method: "POST", path: "/v1/search" },
      { method: "GET", path: "/v1/pages/**" },
      { method: "GET", path: "/v1/blocks/**" },
      { method: "GET", path: "/v1/data_sources/**" },
      { method: "GET", path: "/v1/databases/**" },
      { method: "POST", path: "/v1/data_sources/*/query" },
      { method: "POST", path: "/v1/databases/*/query" },
    ],
  },
  { id: "create", label: "Create pages", rules: () => [{ method: "POST", path: "/v1/pages" }] },
  {
    id: "edit",
    label: "Edit page content and properties",
    hint: "Includes adding blocks to a page and changing a page's properties.",
    rules: () => [
      { method: "PATCH", path: "/v1/blocks/*" },
      { method: "PATCH", path: "/v1/blocks/*/children" },
      { method: "PATCH", path: "/v1/pages/*" },
    ],
  },
  { id: "comment", label: "Comment", rules: () => [{ method: "POST", path: "/v1/comments" }] },
];

// Discord's choices apply to one channel (see DISCORD_SCOPE). Paths keep /v10,
// as discord.js sends them.
export const DISCORD_PRESETS: readonly ServicePreset[] = [
  {
    id: "read",
    label: "Read messages in the channel",
    rules: (channel) => [
      { method: "GET", path: `/v10/channels/${channel}` },
      { method: "GET", path: `/v10/channels/${channel}/messages` },
      { method: "GET", path: `/v10/channels/${channel}/messages/*` },
    ],
  },
  { id: "send", label: "Send messages to the channel", rules: (channel) => [{ method: "POST", path: `/v10/channels/${channel}/messages` }] },
  {
    id: "react",
    label: "Add reactions",
    rules: (channel) => [{ method: "PUT", path: `/v10/channels/${channel}/messages/*/reactions/*/@me` }],
  },
  {
    id: "threads",
    label: "Start threads",
    rules: (channel) => [
      { method: "POST", path: `/v10/channels/${channel}/threads` },
      { method: "POST", path: `/v10/channels/${channel}/messages/*/threads` },
    ],
  },
];

const PRESETS: Readonly<Record<ServiceId, readonly ServicePreset[]>> = {
  github: GITHUB_PRESETS,
  telegram: TELEGRAM_PRESETS,
  brave: BRAVE_PRESETS,
  notion: NOTION_PRESETS,
  discord: DISCORD_PRESETS,
};

export function presetsFor(service: ServiceId | string): readonly ServicePreset[] {
  return isServiceId(service) ? PRESETS[service] : [];
}

/**
 * What a scoped service's choices apply to, and how the form asks for it: one
 * repository for GitHub. A service without one (Telegram: the chat is chosen in
 * each request) has none, and its choices take no argument.
 */
export interface PresetScope {
  /** The form field's label. */
  label: string;
  placeholder: string;
  /** Under the field. */
  help: string;
  /** In "Name the … these choices are for." */
  noun: string;
  /** The save-time refusal when the field cannot be read. */
  invalid: string;
  /** The inline notice for the same. */
  notOne: string;
  /** The scope from what an operator typed or pasted, or null. */
  parse(input: string): string | null;
  /** The scope a saved rule path is about (never a wildcard), or null. */
  fromPath(path: string): string | null;
}

function presetScopes(): Partial<Record<ServiceId, PresetScope>> {
  return { github: GITHUB_SCOPE, discord: DISCORD_SCOPE };
}

export function presetScopeFor(service: ServiceId | string): PresetScope | null {
  return isServiceId(service) ? presetScopes()[service] ?? null : null;
}

/** Whether this service's choices are scoped (to one repository, for GitHub). */
export function presetsNeedRepo(service: ServiceId | string): boolean {
  return presetScopeFor(service) !== null;
}

// GitHub's own limits: an owner is letters, digits and single hyphens; a
// repository name adds `.` and `_`. `.` and `..` alone are not names.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const NAME = /^[A-Za-z0-9._-]{1,100}$/u;

/** `owner/name` from what an operator typed or pasted (a github.com link included), or null. */
export function parseRepoInput(input: string): string | null {
  let value = input.trim();
  const link = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.*)$/iu.exec(value);
  if (link) {
    const [owner, name] = link[1]!.split("/");
    value = `${owner ?? ""}/${(name ?? "").replace(/\.git$/iu, "")}`;
  } else if (/^[a-z]+:\/\//iu.test(value) || /^[^/]*\.[a-z]+\//iu.test(value)) {
    return null;
  }
  const parts = value.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return null;
  return `${owner}/${name}`;
}

const REPO_PATH = /^\/repos\/([^/]+)\/([^/]+)(?:\/|$)/u;

// A Discord snowflake, the id "Copy Channel ID" gives.
const SNOWFLAKE = /^[0-9]{17,20}$/u;
const CHANNEL_PATH = /^\/v10\/channels\/([0-9]{17,20})(?:\/|$)/u;

/** A channel id from what an operator typed, or a discord.com/channels/<server>/<channel> link. */
export function parseChannelInput(input: string): string | null {
  const value = input.trim();
  if (SNOWFLAKE.test(value)) return value;
  const link = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(?:[0-9]{17,20}|@me)\/([0-9]{17,20})\/?$/u.exec(value);
  return link ? link[1]! : null;
}

const DISCORD_SCOPE: PresetScope = {
  label: "Channel",
  placeholder: "Channel ID, or paste its discord.com/channels/… link",
  help: "The choices below apply to this one channel. In Discord, turn on Developer Mode, then right-click the channel and choose Copy Channel ID.",
  noun: "channel",
  invalid: "Enter the channel ID, or paste its discord.com/channels/… link: the choices above apply to one channel.",
  notOne: "That is not a channel ID: copy it in Discord (Developer Mode, then right-click the channel), or paste its link.",
  parse: parseChannelInput,
  fromPath(path) {
    return CHANNEL_PATH.exec(path)?.[1] ?? null;
  },
};

const GITHUB_SCOPE: PresetScope = {
  label: "Repository",
  placeholder: "owner/repo, or paste its github.com link",
  help: "The choices below apply to this one repository. It is matched exactly as your agent's code writes it, capital letters included.",
  noun: "repository",
  invalid: "Enter the repository as owner/name, or paste its github.com link: the choices above apply to one repository.",
  notOne: "That is not a repository: use owner/name, or paste its github.com link.",
  parse: parseRepoInput,
  fromPath(path) {
    const m = REPO_PATH.exec(path);
    return m && m[2] !== "*" && m[2] !== "**" && m[1] !== "*" ? `${m[1]}/${m[2]}` : null;
  },
};

/** A custom rule's path as the parser wants it: trimmed, and with the leading `/` an HTTP rule needs. */
export function normalizeRulePath(shape: "http" | "call", path: string): string {
  const trimmed = path.trim();
  if (shape === "call" || trimmed === "" || trimmed.startsWith("/")) return trimmed;
  return `/${trimmed}`;
}

// Method names (CALL) match in any case at the gateway, so they compare that way
// here; HTTP paths match exactly, so they compare exactly.
function ruleKey(rule: PresetRule): string {
  return rule.method === "CALL" ? `CALL ${rule.path.toLowerCase()}` : `${rule.method} ${rule.path}`;
}

/**
 * Whether any rule for this service can be a write, by the catalog's own test:
 * Brave Search's rules never are, so "Ask me first before each write" would
 * mean nothing there.
 */
export function serviceHasWrites(service: ServiceId | string): boolean {
  if (!isServiceId(service)) return false;
  const entry = SERVICE_CATALOG[service];
  return entry.ruleShape === "call"
    ? entry.isWriteRule({ method: "CALL", path: "sendMessage" })
    : SERVICE_RULE_WRITE_PROBES.some((method) => entry.isWriteRule({ method, path: "/" }));
}
const SERVICE_RULE_WRITE_PROBES = ["POST", "PUT", "PATCH", "DELETE"] as const;

/** Whether this service calls the rule a write (its catalog's own test). */
function isWrite(service: ServiceId | string, rule: PresetRule): boolean {
  return isServiceId(service) ? SERVICE_CATALOG[service].isWriteRule(rule) : rule.method !== "GET";
}

/**
 * The rules the choices and the custom list stand for. `askWrites` is the
 * editor's "Ask me first before each write" switch: it marks every write rule,
 * whichever produced it. A custom rule's own `ask` is kept either way, and a
 * rule asks nothing unless one of the two says so, so a document saved with
 * the switch off is exactly what it was before the switch existed.
 */
export function composeServiceRules(
  service: ServiceId | string,
  input: { repo: string | null; checked: readonly string[]; extra: readonly PresetRule[]; askWrites?: boolean }
): PresetRule[] {
  const shape = ruleShapeFor(service);
  const out: PresetRule[] = [];
  const seen = new Set<string>();
  const add = (rule: PresetRule) => {
    const key = ruleKey(rule);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(rule);
  };
  const canWritePresets = !presetsNeedRepo(service) || input.repo !== null;
  if (canWritePresets) {
    for (const preset of presetsFor(service)) {
      if (input.checked.includes(preset.id)) preset.rules(input.repo ?? undefined).forEach(add);
    }
  }
  for (const rule of input.extra) {
    const path = normalizeRulePath(shape, rule.path);
    if (path) add({ method: rule.method, path, ...(rule.ask ? { ask: true } : {}) });
  }
  return out.map((rule) => {
    const ask = rule.ask === true || (input.askWrites === true && isWrite(service, rule));
    return { method: rule.method, path: rule.path, ...(ask ? { ask: true } : {}) };
  });
}

export function splitServiceRules(
  service: ServiceId | string,
  allow: readonly PresetRule[]
): { repo: string | null; checked: string[]; extra: PresetRule[]; askWrites: boolean } {
  const presets = presetsFor(service);
  const keys = new Set(allow.map(ruleKey));

  const fullyPresent = (preset: ServicePreset, repo?: string) => preset.rules(repo).every((rule) => keys.has(ruleKey(rule)));

  let repo: string | null = null;
  let checked: string[] = [];
  const scope = presetScopeFor(service);
  if (scope) {
    // Every scope the list names, in order; the one with the most complete
    // choices wins, the first on a tie.
    const repos: string[] = [];
    for (const rule of allow) {
      const candidate = scope.fromPath(rule.path);
      if (candidate && !repos.includes(candidate)) repos.push(candidate);
    }
    for (const candidate of repos) {
      const ids = presets.filter((preset) => fullyPresent(preset, candidate)).map((preset) => preset.id);
      if (ids.length > checked.length) {
        repo = candidate;
        checked = ids;
      }
    }
    if (repo === null && repos.length === 1) repo = repos[0]!;
  } else {
    checked = presets.filter((preset) => fullyPresent(preset)).map((preset) => preset.id);
  }

  const consumed = new Set<string>();
  for (const preset of presets) {
    if (checked.includes(preset.id)) preset.rules(repo ?? undefined).forEach((rule) => consumed.add(ruleKey(rule)));
  }
  // On only when there is a write and every write asks: one write left unasked
  // means the owner chose rule by rule, and the custom list shows which.
  const writes = allow.filter((rule) => isWrite(service, rule));
  const askWrites = writes.length > 0 && writes.every((rule) => rule.ask === true);
  const extra = allow
    .filter((rule) => !consumed.has(ruleKey(rule)))
    .map((rule) => ({
      method: rule.method,
      path: rule.path,
      // A write's ask is the switch's when the switch is on; otherwise its own.
      ...(rule.ask && !(askWrites && isWrite(service, rule)) ? { ask: true } : {}),
    }));
  return { repo, checked, extra, askWrites };
}

// ── Service access chosen in "Connect an agent" ──────────────────────────────
//
// A new user who stored a Telegram token did not know an agent also needs
// rules (owner, 2026-10-05). So the wizard shows the choices for the services
// below, pre-ticked with these defaults, whenever the workspace holds that
// service's token. Visible and untickable: an agent created without them still
// has no access, as every agent always has.
//
// Only services whose choices need nothing more (no repository, no channel):
// the wizard has no room for a scope picker.
export const WIZARD_SERVICE_DEFAULTS: Partial<Record<ServiceId, { checked: readonly string[]; askWrites: boolean }>> = {
  // Send asks first: an agent texting people from your bot is the action a
  // new user would want to see before it happens.
  telegram: { checked: ["read", "send"], askWrites: true },
};

export interface WizardServiceChoice {
  service: string;
  checked: string[];
  askWrites: boolean;
}

export type WizardServiceRules =
  | { ok: true; document: Record<string, { allow: Record<string, unknown>[] }> | null; granted: string[] }
  | { ok: false; message: string };

/**
 * The wizard's ticks as the stored rule document, checked by the gateway's own
 * parser. Anything the wizard does not offer is refused, not dropped.
 */
export function wizardServiceRules(choices: unknown): WizardServiceRules {
  if (choices === undefined || choices === null) return { ok: true, document: null, granted: [] };
  if (!Array.isArray(choices)) return { ok: false, message: "That service access is not valid." };
  const document: Record<string, { allow: Record<string, unknown>[] }> = {};
  const granted: string[] = [];
  for (const choice of choices as Partial<WizardServiceChoice>[]) {
    const service = choice?.service;
    if (typeof service !== "string" || !isServiceId(service) || !WIZARD_SERVICE_DEFAULTS[service]) {
      return { ok: false, message: "That service access is not offered when creating an agent." };
    }
    const checked = Array.isArray(choice.checked) ? choice.checked : null;
    const known = new Set(presetsFor(service).map((preset) => preset.id));
    if (!checked || checked.some((id) => typeof id !== "string" || !known.has(id))) {
      return { ok: false, message: "That service access is not valid." };
    }
    if (checked.length === 0 || document[service]) continue;
    const shape = ruleShapeFor(service);
    const allow = composeServiceRules(service, {
      repo: null,
      checked,
      extra: [],
      askWrites: choice.askWrites === true,
    }).map((rule) => ({
      ...(shape === "call" ? { call: rule.path } : { method: rule.method, path: rule.path }),
      ...(rule.ask ? { ask: true } : {}),
    }));
    if (parseServiceRules({ [service]: { allow } }, service).kind !== "rules") {
      return { ok: false, message: "That service access is not valid." };
    }
    document[service] = { allow };
    granted.push(service);
  }
  return { ok: true, document: granted.length ? document : null, granted };
}
