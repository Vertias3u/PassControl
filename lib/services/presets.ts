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
import type { ServiceId } from "./catalog";

export interface PresetRule {
  method: string;
  path: string;
}

export interface ServicePreset {
  id: string;
  label: string;
  /** One line under the choice, when its reach is not obvious from the label. */
  hint?: string;
  /** For a repository-scoped service, the repository as `owner/name`; ignored otherwise. */
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

export function presetsFor(service: ServiceId | string): readonly ServicePreset[] {
  if (service === "github") return GITHUB_PRESETS;
  if (service === "telegram") return TELEGRAM_PRESETS;
  return [];
}

/** Whether this service's choices are scoped to one repository. */
export function presetsNeedRepo(service: ServiceId | string): boolean {
  return service === "github";
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

export function composeServiceRules(
  service: ServiceId | string,
  input: { repo: string | null; checked: readonly string[]; extra: readonly PresetRule[] }
): PresetRule[] {
  const shape = service === "telegram" ? "call" : "http";
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
    if (path) add({ method: rule.method, path });
  }
  return out;
}

const REPO_PATH = /^\/repos\/([^/]+)\/([^/]+)(?:\/|$)/u;

export function splitServiceRules(
  service: ServiceId | string,
  allow: readonly PresetRule[]
): { repo: string | null; checked: string[]; extra: PresetRule[] } {
  const presets = presetsFor(service);
  const keys = new Set(allow.map(ruleKey));

  const fullyPresent = (preset: ServicePreset, repo?: string) => preset.rules(repo).every((rule) => keys.has(ruleKey(rule)));

  let repo: string | null = null;
  let checked: string[] = [];
  if (presetsNeedRepo(service)) {
    // Every repository the list names, in order; the one with the most complete
    // choices wins, the first on a tie.
    const repos: string[] = [];
    for (const rule of allow) {
      const m = REPO_PATH.exec(rule.path);
      if (m && m[2] !== "*" && m[2] !== "**" && m[1] !== "*") {
        const candidate = `${m[1]}/${m[2]}`;
        if (!repos.includes(candidate)) repos.push(candidate);
      }
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
  const extra = allow.filter((rule) => !consumed.has(ruleKey(rule))).map((rule) => ({ method: rule.method, path: rule.path }));
  return { repo, checked, extra };
}
