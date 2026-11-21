// Mission-bound visas (idea 11): the LOCAL-TOOL half of a mission envelope.
//
// One file for both sides, like tool-rules.mjs: the sidecar classifies a Claude Code
// PreToolUse call with it, the gateway validates a mission's `tools` section with it,
// and the replay measurement uses the same classifier on the sanitised feed. The
// three can never disagree about what an item admits.
//
// ── HONEST LIMIT, said in every copy that shows this section ────────────────────
// Hooks are a GUARD RAIL, not a boundary. The sidecar sees what Claude Code tells
// it. A script file, an alias, `sh -c`, an interpreter one-liner or a process the
// agent starts outside Claude Code gets round anything here. The gateway is the
// boundary for models and services, because it holds the credential; this file
// only adds friction to the owner's own sessions.
//
// Item vocabulary (typed, so a whole repository is ONE item, not many paths):
//   { kind: "workspace", root: "/abs/dir", write: bool }  file tools under root
//   { kind: "shell", class: <SHELL_CLASSES> }             a class of shell command
//   { kind: "host", host: "exact.host", via: "web"|"browser"|"shell" }
//   { kind: "tool", name: "ExactToolName" }               one named tool
//   { kind: "memory_write" }                              writes to agent memory files
//
// Classes that are NEVER admitted by a template or by history, only by the owner for
// this one mission: network, opaque, vcs_push, rm_rf, container, memory writes (NEVER_LEARNED).

export const SHELL_CLASSES = [
  "inspect",
  "build",
  "vcs_local",
  "process",
  "fs_mutate",
  "container",
  "network",
  "opaque",
  "vcs_push",
  "rm_rf",
];
// container: `docker run -v /:/host` is a full escape, so a container class learned from
// history admitted it (red team round 1, L24 under strategy D).
export const NEVER_LEARNED = new Set(["shell:network", "shell:opaque", "shell:vcs_push", "shell:rm_rf", "shell:container", "memory_write"]);
export const HOST_VIA = ["web", "browser", "shell"];

const INSPECT = new Set(
  "cd ls cat head tail grep rg egrep fgrep sed awk wc find echo pwd which file stat diff sort uniq cut tr jq less more tree du df date true false test [ printf basename dirname realpath readlink type command whoami uname hostname id cmp comm column nl od xxd shasum sha256sum md5 md5sum base64 strings".split(" ")
);
const BUILD = new Set(
  "npm npx node python python3 pip pip3 tsc vitest jest make cargo go deno bun pnpm yarn pytest ruff eslint prettier psql sqlite3 swift xcodebuild gradle mvn java javac ruby bundle rake".split(" ")
);
const PROCESS = new Set("kill pkill ps lsof sleep wait jobs pgrep top fg bg disown".split(" "));
const FS_MUTATE = new Set("cp mv mkdir touch rm rmdir ln chmod chown tee install unzip tar gzip gunzip zip".split(" "));
const CONTAINER = new Set("docker docker-compose podman kubectl colima".split(" "));
const NETWORK = new Set("curl wget gh ssh scp sftp rsync nc ncat telnet ftp open http https dig nslookup ping".split(" "));
// A command that runs ANOTHER command or arbitrary code is opaque: what it does is not
// in its first word.
const OPAQUE = new Set(
  "bash sh zsh dash fish eval exec source . env sudo doas xargs nohup timeout time watch nice osascript perl for while until if case function select coproc { (".split(" ")
);

/** Tools that act only on the agent's own task list, plans or questions to the owner. */
export const INTERNAL_TOOLS = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "TaskStop",
  "TaskOutput",
  "TodoWrite",
  "ToolSearch",
  "AskUserQuestion",
  "ReadNotifications",
  "Monitor",
  "ListAgents",
  "EnterPlanMode",
  "ExitPlanMode",
  "BashOutput",
  "KillShell",
]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PATH_FIELD = { Read: "file_path", Edit: "file_path", MultiEdit: "file_path", Write: "file_path", NotebookEdit: "notebook_path", Glob: "path", Grep: "path", LS: "path", NotebookRead: "notebook_path" };
const BROWSER_NAV = /^mcp__claude-in-chrome__navigate$/u;

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;
const MEMORY_FILE = /(?:^|\/)(?:CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md|MEMORY\.md|\.claude\/(?:settings(?:\.local)?\.json|memory\/[^/]+|agents\/[^/]+|commands\/[^/]+|skills\/.+))$/u;

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** An absolute, normalised POSIX directory: no `.`/`..`, no `//`, no trailing `/`, not `/`. */
export function validRoot(root) {
  if (typeof root !== "string" || root.length < 2 || root.length > 1024 || !root.startsWith("/")) return false;
  if (root.endsWith("/") || root.includes("//") || root.includes("\\") || /[\u0000-\u001f\u007f]/u.test(root)) return false;
  const parts = root.slice(1).split("/");
  return parts.every((p) => p !== "" && p !== "." && p !== "..");
}

/** Lexical normalisation of an absolute path. Null when it is not absolute or escapes /. */
export function normalisePath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 4096) return null;
  if (path.includes("\\") || /[\u0000-\u001f\u007f]/u.test(path)) return null;
  const out = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join("/")}`;
}

/** Is `path` (already normalised) `root` itself or under it, on a segment boundary? */
export function within(root, path) {
  return path === root || path.startsWith(`${root}/`);
}

export function normaliseHost(raw) {
  if (typeof raw !== "string") return null;
  let host = raw.trim().toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  return HOST.test(host) ? host : null;
}

/** A single tool item, validated. Returns a fresh canonical object or null. */
export function parseToolItem(item) {
  if (!isRecord(item)) return null;
  const keys = Object.keys(item).sort().join(",");
  switch (item.kind) {
    case "workspace":
      if (keys !== "kind,root,write" || !validRoot(item.root) || typeof item.write !== "boolean") return null;
      return { kind: "workspace", root: item.root, write: item.write };
    case "shell":
      if (keys !== "class,kind" || !SHELL_CLASSES.includes(item.class)) return null;
      return { kind: "shell", class: item.class };
    case "host":
      if (keys !== "host,kind,via" || !HOST_VIA.includes(item.via)) return null;
      if (typeof item.host !== "string" || normaliseHost(item.host) !== item.host) return null;
      return { kind: "host", host: item.host, via: item.via };
    case "tool":
      if (keys !== "kind,name" || typeof item.name !== "string" || !TOOL_NAME.test(item.name)) return null;
      return { kind: "tool", name: item.name };
    case "memory_write":
      if (keys !== "kind") return null;
      return { kind: "memory_write" };
    default:
      return null;
  }
}

/** Does item `outer` admit everything item `inner` admits? Conservative: unknown → false. */
export function toolItemContains(outer, inner) {
  if (!outer || !inner || outer.kind !== inner.kind) return false;
  switch (outer.kind) {
    case "workspace":
      return within(outer.root, inner.root) && (outer.write || !inner.write);
    case "shell":
      return outer.class === inner.class;
    case "host":
      return outer.host === inner.host && outer.via === inner.via;
    case "tool":
      return outer.name === inner.name;
    case "memory_write":
      return true;
    default:
      return false;
  }
}

/** A stable key for an item, used for sets and for "learned from history". */
export function toolItemKey(item) {
  switch (item.kind) {
    case "workspace":
      return `workspace:${item.write ? "rw" : "r"}:${item.root}`;
    case "shell":
      return `shell:${item.class}`;
    case "host":
      return `host:${item.via}:${item.host}`;
    case "tool":
      return `tool:${item.name}`;
    case "memory_write":
      return "memory_write";
    default:
      return "unknown";
  }
}

/** The shell class of one simple command's first word (after assignments). */
export function shellClassOf(word) {
  if (typeof word !== "string" || word === "") return "opaque";
  const base = word.includes("/") ? word.slice(word.lastIndexOf("/") + 1) : word;
  if (base === "git") return "vcs_local";
  if (INSPECT.has(base)) return "inspect";
  if (BUILD.has(base)) return "build";
  if (PROCESS.has(base)) return "process";
  if (FS_MUTATE.has(base)) return "fs_mutate";
  if (CONTAINER.has(base)) return "container";
  if (NETWORK.has(base)) return "network";
  if (OPAQUE.has(base)) return "opaque";
  return "opaque";
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
// An interpreter handed code inline runs whatever that code says, so it is opaque, not
// a build step (red team round 1: `python3 -c "urlopen(evil)"` was admitted as build).
const INTERPRETERS = new Set(["python", "python3", "node", "perl", "ruby", "php", "deno", "bun", "osascript", "pwsh", "powershell"]);
const INLINE_CODE = new Set(["-c", "-e", "--eval", "-p", "--print", "-r", "-m", "-E", "-x", "eval", "--command"]);
const REDIRECT = /^(?:\d?[<>]{1,2}|&>|<<<?)$/u;

/**
 * Does an interpreter invocation run code the hook cannot see in its arguments?
 * Inline code (-c, -e, --eval=…, combined -Ic), code from STDIN (no script argument,
 * `-`, /dev/stdin: `echo … | python3`, `python3 - < x`), or code from a URL
 * (`deno run https://…`). Red team round 3 found the stdin and URL forms admitted as
 * build. A script FILE (`python3 x.py`) stays build: what the file does is the named
 * guard-rail limit (RED-TEAM.md L30).
 */
function interpreterRunsUnseenCode(rest) {
  if (rest.length === 1 && ["--version", "-v", "-V", "--help"].includes(rest[0])) return false;
  if (rest.some((a) => INLINE_CODE.has(a) || /^-[a-zA-Z]*[ce]$/u.test(a) || /^--(?:eval|print|command)=/u.test(a))) return true;
  if (rest.some((a) => /^['"]?https?:\/\//u.test(a))) return true;
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (REDIRECT.test(a)) {
      i++; // the redirect's target is not a script
      continue;
    }
    if (/^[<>]/u.test(a)) continue; // `<file` written without a space
    if (a.startsWith("-") && a !== "-") continue;
    positional.push(a);
  }
  if (positional.length === 0) return true;
  // `deno run x.ts`, `bun run x`: the subcommand is not the script.
  const script = ["run", "x", "exec"].includes(positional[0]) ? positional[1] : positional[0];
  return script === undefined || script === "-" || script === "/dev/stdin";
}

/**
 * Split a shell command into simple commands and classify each. Deliberately
 * pessimistic: command substitution, backticks, process substitution, a heredoc or
 * an unbalanced quote make the WHOLE command opaque, because what runs is not in
 * the words we can see. Returns the set of items the command needs.
 */
export function classifyShell(command) {
  const items = new Map();
  const add = (cls) => items.set(`shell:${cls}`, { kind: "shell", class: cls });
  if (typeof command !== "string" || command.length === 0 || command.length > 100_000) {
    add("opaque");
    return [...items.values()];
  }
  if (/\$\(|`|<\(|>\(|<<|\beval\b/u.test(command)) add("opaque");
  // Quote-aware split on ; & | && || and newlines.
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"') {
        current += c + (command[i + 1] ?? "");
        i++;
        continue;
      }
      current += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
      continue;
    }
    if (c === "\\") {
      current += c + (command[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (quote) add("opaque");
  segments.push(current);
  for (const segment of segments) {
    const words = segment.trim().split(/\s+/u).filter(Boolean);
    let w = 0;
    while (w < words.length && ASSIGNMENT.test(words[w])) w++;
    if (w >= words.length) continue; // assignments only, or empty
    const first = words[w].replace(/^['"]|['"]$/gu, "");
    const rest = words.slice(w + 1);
    const base = first.includes("/") ? first.slice(first.lastIndexOf("/") + 1) : first;
    const inline = INTERPRETERS.has(base) && interpreterRunsUnseenCode(rest);
    const cls = inline ? "opaque" : shellClassOf(first);
    if (first === "git" && rest.includes("push")) add("vcs_push");
    else if ((first === "rm" || first.endsWith("/rm")) && rest.some((a) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/u.test(a) || a === "--recursive")) add("rm_rf");
    else add(cls);
    if (cls === "network") {
      for (const arg of rest) {
        const m = /^['"]?https?:\/\/([^/:'"\s?#]+)/u.exec(arg);
        const host = m ? normaliseHost(m[1]) : null;
        if (host) items.set(`host:shell:${host}`, { kind: "host", host, via: "shell" });
      }
    }
    // An append or write to a memory file through the shell.
    if (rest.some((a, i) => (a === ">>" || a === ">") && MEMORY_FILE.test(rest[i + 1] ?? "")) || rest.some((a) => /^>>?\S/u.test(a) && MEMORY_FILE.test(a.replace(/^>>?/u, "")))) {
      items.set("memory_write", { kind: "memory_write" });
    }
  }
  if (items.size === 0) add("inspect");
  return [...items.values()];
}

/**
 * Every item a PreToolUse call needs. A call with no recognisable shape needs the
 * item for its tool name, so an unknown tool is held until the owner names it.
 */
export function itemsForToolCall(input) {
  const tool = typeof input?.tool_name === "string" ? input.tool_name : "";
  const ti = isRecord(input?.tool_input) ? input.tool_input : {};
  if (tool === "Bash") return classifyShell(typeof ti.command === "string" ? ti.command : "");
  if (READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) {
    const field = PATH_FIELD[tool];
    const raw = typeof ti[field] === "string" ? ti[field] : READ_TOOLS.has(tool) && tool !== "Read" ? null : "";
    const write = WRITE_TOOLS.has(tool);
    if (raw === null) return [{ kind: "tool", name: tool }]; // Glob/Grep with no path: the cwd, unknown here
    const path = normalisePath(raw);
    if (path === null) return [{ kind: "tool", name: `${tool}:unresolved-path` }];
    const items = [{ kind: "workspace", root: path, write }];
    if (write && MEMORY_FILE.test(path)) items.push({ kind: "memory_write" });
    return items;
  }
  if (tool === "WebFetch") {
    let host = null;
    try {
      host = normaliseHost(new URL(String(ti.url ?? "")).hostname);
    } catch {
      host = null;
    }
    return [host ? { kind: "host", host, via: "web" } : { kind: "tool", name: "WebFetch:unresolved-host" }];
  }
  if (BROWSER_NAV.test(tool)) {
    let host = null;
    try {
      host = normaliseHost(new URL(String(ti.url ?? "")).hostname);
    } catch {
      host = null;
    }
    return [host ? { kind: "host", host, via: "browser" } : { kind: "tool", name: `${tool}:unresolved-host` }];
  }
  if (TOOL_NAME.test(tool)) return [{ kind: "tool", name: tool }];
  return [{ kind: "tool", name: "unknown-tool" }];
}

/** Items a mission admits for free: the agent's own task list. Never effects. */
export function internalItem(item) {
  return item.kind === "tool" && INTERNAL_TOOLS.has(item.name);
}

/**
 * The decision for a tool call against a mission's `tools` section.
 * `inside` when every needed item is contained in some mission item; otherwise
 * `outside` with the items that were missing. Workspace items of the CALL carry the
 * exact path as `root`, so containment is "the path is under an admitted root".
 */
export function evaluateMissionTools(missionTools, input) {
  const needed = itemsForToolCall(input);
  const missing = needed.filter((n) => !internalItem(n) && !missionTools.some((m) => toolItemContains(m, n)));
  return missing.length ? { state: "outside", missing } : { state: "inside", missing: [] };
}
