// Idea 13: memory with a chain of custody. The pure core, shared by the sidecar (Node)
// and the gateway (edge): no `node:` imports, no network, no clock.
//
// Three things live here, and nothing else:
//
//  1. ENTRIES. A memory file (CLAUDE.md, AGENTS.md, MEMORY.md, a note in a memory folder)
//     is split into entries, so an honest edit to one paragraph does not orphan the rest.
//     An entry is a heading line, a paragraph, a top-level list item with its continuation
//     lines, a fenced block (blank lines included), or YAML front matter. Its identity binds
//     the parser version, its heading ancestry, its exact text, its file and which
//     duplicate it is. Not a CommonMark parser, and not a semantic model: a reorder inside
//     one heading changes no key, and can still change meaning (RED-TEAM.md, accepted limit).
//
//     Normalised, because it is transport and cannot carry an instruction: CRLF and CR to
//     LF; ASCII spaces and tabs at the end of a line; lines that are only ASCII spaces and
//     tabs, between entries. Nothing else. No NFC, no NFKC, no case folding: a lookalike
//     letter or an invisible character is a different key, so it arrives. Folding would
//     run the risk the wrong way, making a hostile variant equal to an accepted entry.
//
//  2. KEYS. HMAC-SHA256 under a per-device salt the gateway never sees: only these hashes
//     leave the machine, and a guessable note ("use pnpm") cannot be confirmed by hashing
//     it at the gateway.
//
//  3. OUTSIDE CONTENT. Which tool calls put content from outside the owner and this
//     machine into the session's context. Decided from the TOOL and where its data came
//     from (a URL's host, a network command), never from what the content says. So a
//     payload that fools every scanner is stamped anyway: the whole point (property 1).
//     A classifier may rank or explain an arrival later; it never decides one exists.
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";

export const PARSER_VERSION = 1;

const enc = new TextEncoder();
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export const sha256Hex = (text) => hex(sha256(enc.encode(text)));
export const hmacHex = (saltHex, text) => hex(hmac(sha256, hexToBytes(saltHex), enc.encode(text)));

function hexToBytes(h) {
  if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) throw new Error("custody salt must be 32 bytes of hex");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── 1. Entries ──────────────────────────────────────────────────────────────────

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
// Top-level: at most one space of indent. Deeper items are continuation lines.
const LIST_ITEM = /^ ?(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const isBlank = (line) => /^[ \t]*$/.test(line);

/**
 * The entries of one memory file, in order: `{ text, scope, digest, occurrence }`.
 * `digest` binds the parser version, the heading ancestry and the text; `occurrence`
 * counts identical digests in this file (1, 2, …).
 */
export function memoryEntries(raw) {
  const lines = String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""));
  const out = [];
  const headings = [];
  let scope = [];
  let buffer = [];
  let bufStart = 0;
  // `start`/`end`: the entry's first and last line (0-based), so it can be cut out exactly.
  const flush = (endLine) => {
    if (buffer.length) out.push({ text: buffer.join("\n"), scope: [...scope], start: bufStart, end: endLine });
    buffer = [];
  };
  const push = (line, at) => {
    if (!buffer.length) bufStart = at;
    buffer.push(line);
  };

  let i = 0;
  // Front matter: one entry, only at the very top.
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      bufStart = 0;
      buffer = lines.slice(0, end + 1);
      flush(end);
      i = end + 1;
    }
  }

  let fence = null; // the opening marker while inside a fenced block
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      push(line, i);
      const m = line.match(FENCE_OPEN);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^ {0,3}(`+|~+)[ \t]*$/.test(line)) {
        fence = null;
        flush(i);
      }
      continue;
    }
    if (isBlank(line)) {
      flush(i - 1);
      continue;
    }
    const open = line.match(FENCE_OPEN);
    if (open) {
      flush(i - 1);
      fence = open[1];
      push(line, i);
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      flush(i - 1);
      const level = heading[1].length;
      while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
      headings.push({ level, title: line.trim() });
      scope = headings.map((h) => h.title);
      push(line, i);
      flush(i);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush(i - 1);
      push(line, i);
      continue;
    }
    // A paragraph line, or a list item's continuation (indented or lazy).
    push(line, i);
  }
  flush(lines.length - 1); // an unclosed fence runs to the end of the file: nothing can hide after it

  const seen = new Map();
  return out.map((e) => {
    const digest = sha256Hex(JSON.stringify(["pc-memory-entry", PARSER_VERSION, "blocks", e.scope, e.text]));
    const occurrence = (seen.get(digest) ?? 0) + 1;
    seen.set(digest, occurrence);
    return { ...e, digest, occurrence };
  });
}

// ── 2. Keys ─────────────────────────────────────────────────────────────────────

/** A file's key: its logical id (e.g. `project:CLAUDE.md`) under the device's salt. */
export const fileKey = (salt, fileId) => hmacHex(salt, JSON.stringify(["pc-memory-file", PARSER_VERSION, fileId]));

/** Each entry's key, binding the file and the duplicate count. Only these leave the machine. */
export function entryKeys(salt, fileId, entries) {
  return entries.map((e) => hmacHex(salt, JSON.stringify(["pc-memory-key", PARSER_VERSION, fileId, e.digest, e.occurrence])));
}

/**
 * The salt's public fingerprint: lets the gateway see a salt change without learning it.
 * It binds the parser version too, so a parser upgrade (which changes every key) reads as
 * one integrity fault the owner re-enrols from, not as every entry arriving (red team R2-2).
 */
export const saltFingerprint = (salt, version = PARSER_VERSION) => hmacHex(salt, `pc-memory-salt-fingerprint\u0000v${version}`);

/** Keys in `next` that `prev` did not have, in `next`'s order. */
export function diffKeys(prev, next) {
  const had = new Set(prev);
  return next.filter((k) => !had.has(k));
}

// ── 3. Outside content ──────────────────────────────────────────────────────────

/** Exactly loopback: `localhost`, 127.0.0.0/8, ::1, 0.0.0.0. Never a name that merely starts so. */
export function isLoopbackHost(host) {
  const h = String(host ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
  return /^127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/.test(h) && h.split(".").every((p) => Number(p) <= 255);
}

function urlHost(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const NETWORK_PROGRAMS = new Set([
  "curl", "wget", "gh", "ssh", "scp", "sftp", "ftp", "nc", "ncat", "netcat", "telnet", "http", "https", "xh",
  "aria2c", "lynx", "w3m", "links", "mail", "mutt", "himalaya", "aws", "gcloud", "gsutil", "az", "doctl",
  "kubectl", "vercel", "supabase", "glab", "hub", "tea", "yt-dlp", "socat",
]);
const GIT_NETWORK = new Set(["clone", "fetch", "pull", "ls-remote", "submodule", "remote"]);
const PACKAGE_INFO = new Set(["view", "info", "show", "search", "docs", "repo"]);
const INTERPRETERS = new Set(["python", "python3", "node", "ruby", "perl", "php", "deno", "bun", "pwsh", "osascript"]);
const PREFIXES = new Set(["sudo", "env", "time", "nohup", "exec", "command", "nice", "timeout", "stdbuf", "xargs", "builtin"]);

const basename = (word) => word.replace(/^.*\//, "");
const words = (segment) => segment.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^['"(]+|['")]+$/g, ""));

/** Every http(s) host literally named in a command, lowercased. */
function commandHosts(text) {
  const hosts = [];
  for (const m of String(text).matchAll(/https?:\/\/(\[[^\]\s]+\]|[^/\s'"`:)]+)/gi)) hosts.push(m[1].toLowerCase());
  return hosts;
}

/**
 * Whether a shell command pulls content from the network into its output: a label for
 * the source (`"curl"`, `"git fetch"`, `"python3 url"`) or null. A provenance rule over
 * the command, not over what comes back. It sees programs it knows; a program that
 * fetches without saying so is the limit named in RED-TEAM.md (L4).
 */
export function bashNetworkSource(command) {
  const text = String(command ?? "");
  // Split into simple commands, including inside $( … ) and backticks.
  const segments = text.split(/\$\(|`|&&|\|\||[;|&\n]/);
  let interpreter = null;
  for (const segment of segments) {
    const w = words(segment);
    let k = 0;
    while (k < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[k]) || PREFIXES.has(w[k]) || /^-/.test(w[k]) && k > 0 && PREFIXES.has(w[k - 1]))) k++;
    if (k >= w.length) continue;
    const program = basename(w[k]);
    const args = w.slice(k + 1);
    if (program === "curl" || program === "wget" || program === "http" || program === "xh") {
      const hosts = commandHosts(segment);
      if (hosts.length && hosts.every(isLoopbackHost)) continue;
      return program;
    }
    if (NETWORK_PROGRAMS.has(program)) return program;
    if (program === "git") {
      // Skip global options (`-C dir`, `-c k=v`) to the subcommand.
      let j = 0;
      while (j < args.length && args[j].startsWith("-")) j += args[j] === "-C" || args[j] === "-c" ? 2 : 1;
      const sub = args[j];
      if (GIT_NETWORK.has(sub)) return `git ${sub}`;
      continue;
    }
    if (["npm", "pnpm", "yarn"].includes(program) && PACKAGE_INFO.has(args[0])) return `${program} ${args[0]}`;
    if (program === "pip" || program === "pip3") {
      if (args[0] === "download") return "pip download";
      continue;
    }
    if (program === "docker" && (args[0] === "pull" || args[0] === "search")) return `docker ${args[0]}`;
    // An interpreter's program text may itself contain `;`, so its URL is looked for in
    // the whole command, not in the segment the split left it.
    if (INTERPRETERS.has(program)) interpreter ??= program;
  }
  if (interpreter && commandHosts(text).some((h) => !isLoopbackHost(h))) return `${interpreter} url`;
  return null;
}

/** POSIX path normalisation with no `node:path` (edge-safe). */
export function normalizePath(p, cwd = "/") {
  const abs = String(p).startsWith("/") ? String(p) : `${cwd}/${p}`;
  const parts = [];
  for (const part of abs.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}
const within = (path, root) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

const READ_TOOLS = new Set(["Read", "Grep", "NotebookRead"]);

/**
 * The outside-content marks one tool call adds to its session: `[{ kind, host? }]`.
 *
 *  web            WebFetch to a non-loopback host, WebSearch
 *  mcp            any MCP tool (browser automation included: a page shows whatever it shows)
 *  shell_network  a shell command that pulls from the network (bashNetworkSource)
 *  outside_read   with `outsideReads`, a Read/Grep outside the workspace and the agent's own roots
 *  workspace_read with `workspaceTrust: "third_party"`, any read or shell call in the workspace
 *
 * `ctx`: `{ cwd, outsideReads?, localRoots?, workspaceTrust? }`.
 */
export function outsideMarks(event, ctx = {}) {
  const tool = String(event?.tool_name ?? "");
  const input = event?.tool_input && typeof event.tool_input === "object" ? event.tool_input : {};
  if (tool === "WebFetch") {
    const host = urlHost(input.url);
    if (host && isLoopbackHost(host)) return [];
    return [host ? { kind: "web", host: host.slice(0, 253) } : { kind: "web" }];
  }
  if (tool === "WebSearch") return [{ kind: "web" }];
  if (tool.startsWith("mcp__") && tool.length > 5) {
    const server = tool.slice(5).split("__")[0];
    return [server ? { kind: "mcp", host: server.slice(0, 64) } : { kind: "mcp" }];
  }
  if (ctx.workspaceTrust === "third_party" && (READ_TOOLS.has(tool) || tool === "Bash" || tool === "Glob")) {
    return [{ kind: "workspace_read" }];
  }
  if (tool === "Bash" || tool === "BashOutput") {
    const source = bashNetworkSource(input.command);
    return source ? [{ kind: "shell_network", host: source }] : [];
  }
  if (ctx.outsideReads && READ_TOOLS.has(tool)) {
    const target = input.file_path ?? input.path ?? input.notebook_path;
    if (typeof target !== "string" || !ctx.cwd) return [];
    const path = normalizePath(target, ctx.cwd);
    const roots = [ctx.cwd, ...(ctx.localRoots ?? [])].map((r) => normalizePath(r));
    if (roots.some((r) => within(path, r))) return [];
    return [{ kind: "outside_read" }];
  }
  return [];
}

// ── API mode: what the model was actually given ─────────────────────────────────

const SECTION = /Contents of (\/[^\n]*?) \(([^\n]*)\):\n\n/g;

/**
 * Claude Code's memory sections inside an Anthropic Messages request body:
 * `[{ path, text }]`. Only from the system prompt and the user's own text blocks, never
 * from a tool result: a tool result that quotes the marker is content, not a load.
 */
export function requestMemorySections(body) {
  const texts = [];
  const take = (block) => {
    if (typeof block === "string") texts.push(block);
    else if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") texts.push(block.text);
  };
  if (typeof body?.system === "string") texts.push(body.system);
  else if (Array.isArray(body?.system)) body.system.forEach(take);
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") texts.push(message.content);
    else if (Array.isArray(message.content)) message.content.forEach(take);
  }
  const out = [];
  for (const text of texts) {
    const marks = [...text.matchAll(SECTION)];
    marks.forEach((m, n) => {
      const start = m.index + m[0].length;
      const next = n + 1 < marks.length ? marks[n + 1].index : text.length;
      let section = text.slice(start, next);
      const close = section.indexOf("</system-reminder>");
      if (close >= 0) section = section.slice(0, close);
      out.push({ path: m[1], text: section.replace(/\s+$/, "") });
    });
  }
  return out;
}

// ── Direction 1: withhold pending entries from what the model reads ─────────────

export const WITHHELD_ENTRY = (n) =>
  `[PassControl withheld ${n} memory ${n === 1 ? "entry" : "entries"} here: waiting for the owner's review. Do not try to recover ${n === 1 ? "it" : "them"}.]`;
export const WITHHELD_LINE = "[PassControl withheld a line of a memory entry waiting for the owner's review]";
// Claude Code's Read prints `     1\ttext` (or `  12→text` in newer versions): match the text after the number.
const NUMBERED = /^(\s*\d+(?:\t|\u2192))(.*)$/;

/**
 * A copy of an Anthropic Messages request with pending memory taken out (idea 13, direction 1).
 *
 *  - every Claude Code memory section ("Contents of <path> (…):") in the system prompt or the
 *    user's text is parsed with the SAME parser as the disk (so the keys agree), and
 *    `decide({ path, entries })` names the entries to cut (a Set of indices, or "all");
 *  - every tool result has any line equal to one of `stripLines` replaced (a Read of a memory
 *    file shows its lines, numbered or not);
 *  - `probes` (pending text) still found anywhere in the result is counted as `residue`: text
 *    that could not be cut, so the caller holds instead.
 * The input is not mutated.
 */
export function withholdRequest(body, { decide, stripLines = [], probes = [] }) {
  const copy = structuredClone(body);
  let sectionsChanged = 0, entriesWithheld = 0, linesWithheld = 0;
  const strip = new Set(stripLines.map((l) => String(l).replace(/[ \t]+$/, "")).filter((l) => l.trim().length >= 6));

  const cutSections = (text) => {
    const marks = [...text.matchAll(SECTION)];
    if (!marks.length) return text;
    let out = "";
    let cursor = 0;
    marks.forEach((m, n) => {
      const start = m.index + m[0].length;
      let end = n + 1 < marks.length ? marks[n + 1].index : text.length;
      const close = text.slice(start, end).indexOf("</system-reminder>");
      if (close >= 0) end = start + close;
      const section = text.slice(start, end);
      const entries = memoryEntries(section);
      const verdict = decide({ path: m[1], entries });
      const cut = verdict === "all" ? new Set(entries.map((_, k) => k)) : verdict ?? new Set();
      out += text.slice(cursor, start);
      if (!cut.size) {
        out += section;
      } else {
        const raw = section.split(/\r\n|\r|\n/);
        const drop = new Set();
        let firstCut = Infinity;
        for (const k of cut) {
          const e = entries[k];
          if (!e) continue;
          for (let l = e.start; l <= e.end; l++) drop.add(l);
          firstCut = Math.min(firstCut, e.start);
        }
        const kept = [];
        raw.forEach((line, l) => {
          if (l === firstCut) kept.push(WITHHELD_ENTRY(cut.size));
          if (!drop.has(l)) kept.push(line);
        });
        out += kept.join("\n");
        sectionsChanged++;
        entriesWithheld += cut.size;
      }
      cursor = end;
    });
    return out + text.slice(cursor);
  };
  const cutLines = (text) => {
    if (!strip.size) return text;
    return text
      .split("\n")
      .map((line) => {
        const m = line.replace(/\r$/, "").match(NUMBERED);
        const bare = (m ? m[2] : line.replace(/\r$/, "")).replace(/[ \t]+$/, "");
        // A long pending line shown cut short (Read truncates very long lines) is cut too (R4-3).
        const hit = strip.has(bare) || (bare.length >= 32 && [...strip].some((l) => l.startsWith(bare)));
        if (!hit) return line;
        linesWithheld++;
        return m ? `${m[1]}${WITHHELD_LINE}` : WITHHELD_LINE;
      })
      .join("\n");
  };

  if (typeof copy?.system === "string") copy.system = cutSections(copy.system);
  else if (Array.isArray(copy?.system)) for (const b of copy.system) if (b?.type === "text" && typeof b.text === "string") b.text = cutSections(b.text);
  for (const message of Array.isArray(copy?.messages) ? copy.messages : []) {
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") {
      message.content = cutSections(message.content);
      continue;
    }
    for (const b of Array.isArray(message.content) ? message.content : []) {
      if (b?.type === "text" && typeof b.text === "string") b.text = cutSections(b.text);
      if (b?.type === "tool_result") {
        if (typeof b.content === "string") b.content = cutLines(b.content);
        else if (Array.isArray(b.content)) for (const c of b.content) if (c?.type === "text" && typeof c.text === "string") c.text = cutLines(c.text);
      }
    }
  }
  const serialized = JSON.stringify(copy);
  const residue = probes.filter((p) => String(p).trim().length >= 16 && serialized.includes(JSON.stringify(String(p).trim()).slice(1, -1))).length;
  return { body: copy, sectionsChanged, entriesWithheld, linesWithheld, residue };
}
