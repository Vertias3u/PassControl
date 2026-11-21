// Idea 13: which files an agent remembers with, and their entries' keys right now.
//
// The default set follows what each client documents it loads (SOURCES.md #1), and errs
// wide: a file the client might load is in the set even when it might not be.
//
//   claude-code  CLAUDE.md, CLAUDE.local.md and AGENTS.md in the working directory and
//                every directory above it; .claude/CLAUDE.md; .claude/rules/**/*.md;
//                nested CLAUDE.md / CLAUDE.local.md / AGENTS.md anywhere in the workspace
//                (Claude Code loads those on demand); ~/.claude/CLAUDE.md and
//                ~/.claude/rules/**; the managed CLAUDE.md; the auto-memory folder
//                (~/.claude/projects/<repo>/memory/**, and any `autoMemoryDirectory` a
//                settings file names); and every `@import` those files make, four hops deep.
//   codex        AGENTS.md and AGENTS.override.md from the git root down to the working
//                directory, and $CODEX_HOME/AGENTS(.override).md.
//
// The owner adds their own paths on the agent's page. That list is held at the gateway and
// arrives with /self, never from a file here: a file here is one the agent can edit, and an
// agent that could shrink the set could hide a file from it. The owner can only ADD.
//
// Symlinks are followed, because the client follows them: what is hashed is what loads.
// A file that cannot be read, or is over the client's own size limit, is an `error`, and an
// error holds like an arrival. Nothing here decides custody; it only says what is there.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { entryKeys, fileKey, memoryEntries, saltFingerprint, hmacHex } from "./memory-custody.mjs";

export const FILE_LIMIT_BYTES = 4 * 1024 * 1024; // Claude Code skips a CLAUDE.md over 4 MiB
export const TOTAL_LIMIT_BYTES = 32 * 1024 * 1024;
export const MAX_FILES = 2000;
const IMPORT_HOPS = 4;
const WALK_MAX_DIRS = 20000;
const WALK_SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", ".venv", "venv", "__pycache__", "target", ".turbo", ".cache"]);

/** Labels shown to the owner: a closed set, never a file name the agent chose. */
export const LABELS = [
  "project_instructions", // CLAUDE.md, .claude/CLAUDE.md, AGENTS.md at the workspace root
  "local_instructions", // CLAUDE.local.md
  "ancestor_instructions", // the same files in a directory above the workspace
  "nested_instructions", // the same files in a subdirectory, loaded on demand
  "rules_file", // .claude/rules/**
  "user_instructions", // ~/.claude/CLAUDE.md, ~/.claude/rules/**
  "managed_instructions",
  "memory_index", // MEMORY.md in the auto-memory folder
  "memory_note", // any other file in the auto-memory folder
  "imported_file", // reached through an @import
  "codex_instructions",
  "owner_path",
];

/** The device's custody salt: created once, 0600. The gateway only ever sees its fingerprint. */
export function custodySalt({ env = process.env } = {}) {
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  const file = path.join(base, "passcontrol", "memory-custody-salt");
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(value)) return value;
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const value = randomBytes(32).toString("hex");
  fs.writeFileSync(file, `${value}\n`, { mode: 0o600, flag: "w" });
  return value;
}

/** The workspace root: the nearest directory above `cwd` with a `.git`, else `cwd`. */
export function workspaceRoot(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

/** Claude Code's project folder name: every character that is not a letter or digit becomes `-`. */
export const claudeProjectDirName = (root) => root.replace(/[^A-Za-z0-9]/g, "-");

const ancestors = (from) => {
  const out = [];
  let dir = path.resolve(from);
  for (;;) {
    out.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
};

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const expandHome = (p, home) => (p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p);

/** Markdown files under `dir`, recursively, with a loop guard. */
function markdownUnder(dir, { limit = MAX_FILES } = {}) {
  const out = [];
  const seen = new Set();
  let truncated = false;
  const walk = (d, depth) => {
    if (out.length >= limit) { truncated = true; return; }
    let real;
    try {
      real = fs.realpathSync(d);
    } catch (e) {
      if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") truncated = true;
      return;
    }
    if (seen.has(real)) return;
    if (depth > 12) { truncated = true; return; }
    seen.add(real);
    let names;
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      truncated = true;
      return;
    }
    for (const e of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (out.length >= limit) { truncated = true; return; }
      const p = path.join(d, e.name);
      let stat;
      try {
        stat = fs.statSync(p);
      } catch {
        truncated = true;
        continue;
      }
      if (stat.isDirectory()) walk(p, depth + 1);
      else if (stat.isFile() && /\.md$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir, 0);
  return { files: out, truncated };
}

/** Nested instruction files anywhere in the workspace (loaded on demand by Claude Code). */
function nestedInstructions(root, names) {
  const out = [];
  let dirs = 0;
  let truncated = false;
  const walk = (d, depth) => {
    if (depth > 24 || dirs++ > WALK_MAX_DIRS) { truncated = true; return; }
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      truncated = true;
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !WALK_SKIP.has(e.name)) walk(path.join(d, e.name), depth + 1);
      else if ((e.isFile() || e.isSymbolicLink()) && names.has(e.name) && d !== root) out.push(path.join(d, e.name));
    }
    // .claude/rules inside a nested directory loads on demand too
    if (d !== root && fs.existsSync(path.join(d, ".claude", "rules"))) {
      const rules = markdownUnder(path.join(d, ".claude", "rules"));
      out.push(...rules.files);
      if (rules.truncated) truncated = true;
    }
  };
  walk(root, 0);
  return { files: out, truncated };
}

/** `@path` imports outside code spans and fences (the client's own rule). */
export function importsOf(text) {
  const out = [];
  let fence = null;
  for (const line of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (m) {
      if (!fence) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const stripped = line.replace(/`[^`]*`/g, " ");
    for (const im of stripped.matchAll(/(?:^|\s)@((?:\\ |[^\s])+)/g)) out.push(im[1].replace(/\\ /g, " "));
  }
  return out;
}

/**
 * The memory set: `[{ id, label, path }]`, ids unique and stable for this workspace.
 * @param {{ cwd: string, agent?: "claude-code" | "codex", env?: object, ownerPaths?: string[] }} options
 */
export function memoryFiles({ cwd, agent = "claude-code", env = process.env, ownerPaths = [], touchedDirs = [], touchedFiles = [] }) {
  const home = env.HOME || os.homedir();
  const root = workspaceRoot(cwd);
  const files = new Map(); // id → { id, label, path }
  const accessed = new Set(touchedFiles.filter((p) => typeof p === "string" && p).map((p) => path.resolve(cwd, p)));
  let overflow = false;
  const add = (id, label, p) => {
    if (files.has(id)) return;
    // Past the cap a file is not silently left out: the scan reports an error, which holds
    // (red team R1-7: a poisoned note hid as file 2,001).
    if (files.size >= MAX_FILES) {
      overflow = true;
      // Keep a specifically accessed memory file visible even when the bulk set is full.
      if (!accessed.has(p)) return;
      const victim = [...files.values()].reverse().find((f) => !accessed.has(f.path));
      if (!victim) return;
      files.delete(victim.id);
    }
    files.set(id, { id, label, path: p });
  };
  let walkTruncated = false;
  const markdown = (dir) => {
    const r = markdownUnder(dir);
    if (r.truncated) walkTruncated = true;
    // Only memory directories already in scope qualify; an ordinary source Read is not memory.
    return [...new Set([...accessed].filter((p) => p.startsWith(path.resolve(dir) + path.sep) && /\.md$/i.test(p)).concat(r.files))];
  };
  const nested = (names) => {
    const r = nestedInstructions(root, names);
    if (r.truncated) walkTruncated = true;
    return r.files;
  };
  const idFor = (p) => {
    const abs = path.resolve(p);
    if (abs === root || abs.startsWith(root + path.sep)) return `project:${path.relative(root, abs)}`;
    if (abs.startsWith(home + path.sep)) return `home:${path.relative(home, abs)}`;
    return `abs:${abs}`;
  };

  if (agent === "codex") {
    const codexHome = env.CODEX_HOME || path.join(home, ".codex");
    for (const name of ["AGENTS.md", "AGENTS.override.md"]) add(`codex:${name}`, "codex_instructions", path.join(codexHome, name));
    for (const dir of ancestors(cwd)) {
      for (const name of ["AGENTS.md", "AGENTS.override.md"]) add(idFor(path.join(dir, name)), dir === root ? "project_instructions" : "ancestor_instructions", path.join(dir, name));
      if (dir === root) break;
    }
    for (const f of nested(new Set(["AGENTS.md", "AGENTS.override.md"]))) add(idFor(f), "nested_instructions", f);
  } else {
    const config = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
    add("managed:CLAUDE.md", "managed_instructions", process.platform === "darwin" ? "/Library/Application Support/ClaudeCode/CLAUDE.md" : "/etc/claude-code/CLAUDE.md");
    add("user:CLAUDE.md", "user_instructions", path.join(config, "CLAUDE.md"));
    for (const f of markdown(path.join(config, "rules"))) add(`user:rules/${path.relative(path.join(config, "rules"), f)}`, "user_instructions", f);
    for (const dir of ancestors(cwd)) {
      const label = (name) => (name === "CLAUDE.local.md" ? "local_instructions" : dir === root || dir === path.resolve(cwd) ? "project_instructions" : "ancestor_instructions");
      for (const name of ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"]) add(idFor(path.join(dir, name)), label(name), path.join(dir, name));
    }
    add(idFor(path.join(cwd, ".claude", "CLAUDE.md")), "project_instructions", path.join(cwd, ".claude", "CLAUDE.md"));
    for (const f of markdown(path.join(root, ".claude", "rules"))) add(idFor(f), "rules_file", f);
    for (const f of nested(new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"]))) {
      add(idFor(f), f.includes(`${path.sep}.claude${path.sep}rules${path.sep}`) ? "rules_file" : "nested_instructions", f);
    }
    // Auto memory: the default folder, plus any folder a settings file points it at.
    const memoryDirs = new Set([path.join(config, "projects", claudeProjectDirName(root), "memory")]);
    for (const s of [path.join(config, "settings.json"), path.join(root, ".claude", "settings.json"), path.join(root, ".claude", "settings.local.json")]) {
      const v = readJson(s)?.autoMemoryDirectory;
      if (typeof v === "string" && v) memoryDirs.add(path.resolve(root, expandHome(v, home)));
    }
    for (const dir of memoryDirs) {
      const tag = dir === [...memoryDirs][0] ? "automem" : `automem@${idFor(dir)}`;
      add(`${tag}:MEMORY.md`, "memory_index", path.join(dir, "MEMORY.md"));
      for (const f of markdown(dir)) {
        const rel = path.relative(dir, f);
        add(`${tag}:${rel}`, rel === "MEMORY.md" ? "memory_index" : "memory_note", f);
      }
    }
    // Imports, breadth-first, four hops.
    let frontier = [...files.values()];
    for (let hop = 0; hop < IMPORT_HOPS && frontier.length; hop++) {
      const next = [];
      for (const f of frontier) {
        let text;
        try {
          text = fs.readFileSync(f.path, "utf8");
        } catch {
          continue;
        }
        for (const target of importsOf(text)) {
          const p = path.resolve(path.dirname(f.path), expandHome(target, home));
          const id = `import:${idFor(p)}`;
          if (files.has(id) || [...files.values()].some((x) => x.path === p)) continue;
          add(id, "imported_file", p);
          next.push(files.get(id));
        }
      }
      frontier = next.filter(Boolean);
    }
    // Four hops bounds work, not trust: report any imports the bound left unvisited.
    for (const f of frontier) {
      let text;
      try { text = fs.readFileSync(f.path, "utf8"); } catch { continue; }
      if (importsOf(text).some((target) => {
        const p = path.resolve(path.dirname(f.path), expandHome(target, home));
        return ![...files.values()].some((x) => x.path === p);
      })) walkTruncated = true;
    }
  }

  // Directories a tool of this agent worked in: Claude Code loads the instruction files of
  // any directory it reads or writes in, including ones the walk skips (node_modules, dist):
  // red team R1-8. Their ancestors up to the workspace root are covered too.
  const names = agent === "codex" ? ["AGENTS.md", "AGENTS.override.md"] : ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"];
  for (const raw of touchedDirs) {
    if (typeof raw !== "string") continue;
    let dir = path.resolve(raw);
    if (!(dir === root || dir.startsWith(root + path.sep))) continue;
    for (; dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
      for (const name of names) add(idFor(path.join(dir, name)), "nested_instructions", path.join(dir, name));
      if (agent !== "codex") for (const f of markdown(path.join(dir, ".claude", "rules"))) add(idFor(f), "rules_file", f);
    }
  }
  for (const raw of ownerPaths) {
    if (typeof raw !== "string" || !raw) continue;
    if (raw.length > 512) { walkTruncated = true; continue; }
    const p = path.resolve(root, expandHome(raw, home));
    let stat = null;
    try {
      stat = fs.statSync(p);
    } catch {}
    if (stat?.isDirectory()) for (const f of markdown(p)) add(`owner:${raw}/${path.relative(p, f)}`, "owner_path", f);
    else add(`owner:${raw}`, "owner_path", p);
  }
  return { root, files: [...files.values()].sort((a, b) => Number(accessed.has(b.path)) - Number(accessed.has(a.path))), overflow, truncated: walkTruncated };
}

/**
 * Read and key the memory set. Files that do not exist are left out: an absent file has
 * no entries. Returns `{ root, workspace, saltFp, files: [{ id, label, fileKey, keys, entries, bytes, link }], errors }`.
 * `entries` (with text) stays on this machine; only `fileKey`, `keys` and `label` are sent.
 */
export function scanMemory({ salt, cwd, agent = "claude-code", env = process.env, ownerPaths = [], touchedDirs = [], touchedFiles = [] }) {
  const { root, files, overflow, truncated } = memoryFiles({ cwd, agent, env, ownerPaths, touchedDirs, touchedFiles });
  const out = [];
  const errors = overflow ? [{ id: "inventory:overflow", label: "memory_note", reason: "too_many_files" }] : [];
  if (truncated) errors.push({ id: "inventory:truncated", label: "memory_note", reason: "enumeration_incomplete" });
  let total = 0;
  for (const f of files) {
    let lstat;
    try {
      lstat = fs.lstatSync(f.path);
    } catch (e) {
      if (e?.code === "ENOENT" || e?.code === "ENOTDIR") continue;
      errors.push({ id: f.id, label: f.label, reason: "unreadable" });
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(f.path);
    } catch {
      // A dangling symlink loads nothing, but someone pointed it somewhere: say so.
      errors.push({ id: f.id, label: f.label, reason: "dangling_link" });
      continue;
    }
    if (!stat.isFile()) {
      errors.push({ id: f.id, label: f.label, reason: "not_a_file" });
      continue;
    }
    if (stat.size > FILE_LIMIT_BYTES || total + stat.size > TOTAL_LIMIT_BYTES) {
      errors.push({ id: f.id, label: f.label, reason: "too_large" });
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(f.path, "utf8");
    } catch {
      errors.push({ id: f.id, label: f.label, reason: "unreadable" });
      continue;
    }
    total += stat.size;
    const entries = memoryEntries(text);
    const keys = entryKeys(salt, f.id, entries);
    out.push({
      id: f.id,
      label: f.label,
      path: f.path,
      fileKey: fileKey(salt, f.id),
      keys,
      entries: entries.map((e, n) => ({ key: keys[n], text: e.text, scope: e.scope })),
      bytes: stat.size,
      link: lstat.isSymbolicLink(),
    });
  }
  return { root, workspace: hmacHex(salt, `pc-memory-workspace\0${root}`), saltFp: saltFingerprint(salt), files: out, errors };
}

/** Every key in a scan, for snapshot diffs. */
export const scanKeys = (scan) => scan.files.flatMap((f) => f.keys);
