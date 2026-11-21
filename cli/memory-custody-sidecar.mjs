// Idea 13: the sidecar's half of memory custody. It sees the hooks Claude Code and Codex
// already send (and, in API mode, every model request), and turns them into the three
// ledger calls (observe, record, check) at POST /api/v1/memory-custody. Only hashes,
// file kinds and outside-content kinds leave; entry text never does.
//
//   first prompt, or first tool   check: every key present now. Arrivals arm the hold.
//   before each tool              rescan; a change no tool of this session made since the
//                                 last scan (an `echo >>` from a background job, the owner's
//                                 editor, another session) is checked at once, so it holds
//                                 before the tool runs.
//   after each tool               outside-content marks for what the tool brought in
//                                 (cli/memory-custody.mjs outsideMarks), then rescan: new keys
//                                 are recorded as written by this session, with its marks.
//   API mode: each model request  the same "after" for the tool results it carries, and the
//                                 memory sections Claude Code actually put in the context are
//                                 hashed and checked too, so a file swapped back after the
//                                 load is still caught.
//
// The hold, as the tool gate sees it (`state()`):
//   off      the owner has memory custody off (or this sidecar has not yet read /self)
//   clear    the last answer said nothing waits
//   held     arrivals or rejected entries wait, or the device's last check could not be
//            completed: FAIL CLOSED, because an unknown custody state was not cleared
//
// Honest limit (RED-TEAM.md L1): this runs as the same user as the agent. An agent with a
// shell can stop it, rewrite it or its hook settings, or talk to the gateway with the
// agent's own credential. The ledger at the gateway limits what that can launder (sticky
// marks, the agent-wide exposure window, first custody wins, no decisions on the agent
// plane), but a sidecar the agent has replaced reports whatever the agent wants.
import { diffKeys, entryKeys, fileKey, memoryEntries, outsideMarks, requestMemorySections, withholdRequest } from "./memory-custody.mjs";
import fs from "node:fs";
import { custodySalt, scanMemory, workspaceRoot } from "./memory-inventory.mjs";

const DECLARED = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_SESSIONS = 512;
const MAX_SEEN_TOOL_USES = 4096;

/**
 * @param {{
 *   send: (body: object) => Promise<{ status: number, body: any }>,
 *   env?: object,
 *   now?: () => number,
 *   salt?: string,
 *   onWarn?: (message: string) => void,
 *   claudeHome?: string,
 * }} options
 */
export function createMemoryCustody({ send, env = process.env, now = Date.now, salt = null, onWarn = () => {} }) {
  let mode = "unknown"; // from /self: "off" | "hold" | "withhold" | "unknown"
  let integrity = "ok"; // the latest check's
  const on = () => mode === "hold" || mode === "withhold";
  let paths = [];
  let gatewayHeld = false; // the latest answer that said
  let failed = false; // the device's last check could not be completed
  const sessions = new Map();
  const roots = new Map(); // workspace root → { keys: string[], scan }
  const touched = new Set(); // directories tools worked in (R1-8), bounded
  // Explicit tool paths, including memory outside the workspace. Both sets are bounded and
  // evict the oldest. That is not a coverage gap: a file only these sets reach lies either
  // past a walker bound, which reports enumeration_incomplete itself, or in a directory the
  // walk skips by design, and a path in use is touched again before the scan that follows
  // it. A sticky overflow error here would hold a long-lived sidecar forever (A-10 review).
  const touchedFiles = new Set();
  const MAX_TOUCHED = 4096;
  function touch(input) {
    const ti = input?.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
    const candidates = [ti.file_path, ti.path, ti.notebook_path];
    // A shell read counts too (`cat node_modules/x/y` loads that directory's CLAUDE.md):
    // path-like words of the command that exist on disk.
    if (typeof ti.command === "string") {
      for (const word of ti.command.split(/[\s;|&<>()]+/).slice(0, 64)) {
        const w = word.replace(/^['"]+|['"]+$/g, "");
        if (!w || w.startsWith("-") || !/[/.]/.test(w)) continue;
        const abs = w.startsWith("/") ? w : typeof input.cwd === "string" ? `${input.cwd}/${w}` : null;
        try {
          if (abs && fs.existsSync(abs)) candidates.push(fs.statSync(abs).isDirectory() ? `${abs}/.` : abs);
        } catch {}
      }
    }
    for (const p of candidates) {
      if (typeof p !== "string" || !p) continue;
      const abs = p.startsWith("/") ? p : typeof input.cwd === "string" ? `${input.cwd}/${p}` : null;
      if (!abs) continue;
      if (!touchedFiles.has(abs)) {
        touchedFiles.add(abs);
        if (touchedFiles.size > MAX_TOUCHED) touchedFiles.delete(touchedFiles.values().next().value);
      }
      const dir = abs.replace(/\/+[^/]*$/, "") || "/";
      if (touched.has(dir)) continue;
      touched.add(dir);
      if (touched.size > MAX_TOUCHED) touched.delete(touched.values().next().value);
    }
  }
  let deviceSalt = salt;

  const theSalt = () => (deviceSalt ??= custodySalt({ env }));
  const sessionOf = (input) => {
    const id = typeof input?.session_id === "string" && DECLARED.test(input.session_id) ? input.session_id : null;
    if (!id) return null;
    let s = sessions.get(id);
    if (!s) {
      s = { id, cwd: null, client: "claude-code", marks: new Map(), checked: false, inflight: 0, seen: new Set() };
      sessions.set(id, s);
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    }
    if (typeof input.cwd === "string" && input.cwd.startsWith("/")) s.cwd = input.cwd;
    return s;
  };

  /** /self's `memory` view (undefined when the owner has it off). */
  function setView(view) {
    if (view === undefined || view === null) {
      mode = "off";
      return;
    }
    if (view && (view.mode === "hold" || view.mode === "withhold")) {
      mode = view.mode;
      paths = Array.isArray(view.paths) ? view.paths.filter((p) => typeof p === "string").slice(0, 20) : [];
      if (Array.isArray(view.integrity)) integrity = view.integrity.length ? String(view.integrity[0]) : "ok";
      if (view.readable === false) gatewayHeld = true;
      else if (typeof view.held === "boolean") gatewayHeld = view.held;
    }
  }

  /**
   * The hold for one session. In `withhold` mode (direction 1) a session whose model
   * requests pass through this sidecar has its pending memory cut out of every request, so
   * it is not held for arrivals. It is held when withholding cannot be guaranteed: a check
   * that did not complete, an integrity fault, pending text found where it could not be cut
   * (residue), pending lines too short or shared with clean memory to cut safely,
   * or a session no request of has passed here (subscription mode, Codex).
   */
  function state(sessionId) {
    if (!on()) return "off";
    if (mode === "hold") return gatewayHeld || failed ? "held" : "clear";
    const s = typeof sessionId === "string" ? sessions.get(sessionId) : null;
    if (failed || integrity !== "ok" || s?.residue) return "held";
    // Unheld only for a session whose OWN tool hooks are API-mode hooks: a subscription session
    // whose real hooks say so stays held even if a request with its id is sent through here (R4-6).
    if (!s?.api || !s.apiHook || s.nonApi) return gatewayHeld ? "held" : "clear";
    if (pendingText().requiresHold) return "held";
    return "clear";
  }

  function scan(s) {
    const cwd = s.cwd;
    if (!cwd) return null;
    return scanMemory({ salt: theSalt(), cwd, agent: s.client === "codex" ? "codex" : "claude-code", env, ownerPaths: paths, touchedDirs: [...touched], touchedFiles: [...touchedFiles] });
  }
  const filesOf = (scanned, extra = []) => [
    ...scanned.files.map((f) => ({ fileKey: f.fileKey, label: f.label, keys: f.keys })),
    ...extra,
  ];
  const errorsOf = (scanned) => scanned.errors.map((e) => ({ fileKey: fileKey(theSalt(), e.id), label: e.label, reason: e.reason }));

  async function call(body) {
    try {
      return await send(body);
    } catch {
      return { status: 0, body: null };
    }
  }

  async function runCheck(s, scanned, extra = []) {
    const r = await call({
      action: "check",
      session: s.id,
      workspace: scanned.workspace,
      salt_fp: scanned.saltFp,
      files: filesOf(scanned, extra),
      errors: errorsOf(scanned),
    });
    if (r.status === 409 && r.body?.error === "memory_custody_off") {
      mode = "off";
      failed = false;
      return;
    }
    if (r.status !== 200 || typeof r.body?.hold !== "boolean") {
      // Fail closed: the hold stays armed until a check completes.
      failed = true;
      onWarn("PassControl could not complete this agent's memory check, so its risky tools are held until it can.");
      return;
    }
    failed = false;
    gatewayHeld = r.body.hold;
    integrity = typeof r.body.integrity === "string" ? r.body.integrity : "ok";
    s.checked = true;
    roots.set(scanned.root, {
      keys: [...scanned.files.flatMap((f) => f.keys), ...extra.flatMap((f) => f.keys)],
      scanned,
      // What the gateway says still waits (arrivals and rejected entries present): hashes only.
      pending: new Set(Array.isArray(r.body.pending_keys) ? r.body.pending_keys.filter((k) => typeof k === "string") : []),
    });
  }

  async function addMarks(s, marks) {
    const fresh = [];
    for (const m of marks) {
      const id = `${m.kind}|${m.host ?? ""}`;
      if (!s.marks.has(id)) {
        s.marks.set(id, m);
        fresh.push(m);
      }
    }
    if (fresh.length) {
      const r = await call({ action: "observe", session: s.id, marks: fresh });
      if (r.status !== 200) failed = true;
    }
  }

  async function ensureChecked(s) {
    if (s.checked && !failed) return;
    const scanned = scan(s);
    if (scanned) await runCheck(s, scanned);
  }

  /** After a tool (or a batch of them) ran in session `s`. */
  async function afterTools(s, calls) {
    const marks = [];
    for (const c of calls) {
      touch({ cwd: s.cwd, tool_input: c.tool_input });
      marks.push(...outsideMarks(c, { cwd: s.cwd ?? undefined }));
    }
    await addMarks(s, marks);
    const scanned = scan(s);
    if (!scanned) return;
    const before = roots.get(scanned.root);
    if (!before || !s.checked) return void (await runCheck(s, scanned));
    const now_ = scanned.files.flatMap((f) => f.keys);
    const added = diffKeys(before.keys, now_);
    const removed = before.keys.length !== now_.length || diffKeys(now_, before.keys).length > 0;
    if (added.length) {
      const byKey = new Map(scanned.files.flatMap((f) => f.keys.map((k) => [k, f])));
      const r = await call({
        action: "record",
        session: s.id,
        workspace: scanned.workspace,
        salt_fp: scanned.saltFp,
        entries: added.map((k) => ({ key: k, fileKey: byKey.get(k).fileKey, label: byKey.get(k).label })),
        marks: [...s.marks.values()],
      });
      if (r.status === 409 && (r.body?.error === "not_enrolled" || r.body?.error === "salt_changed")) return void (await runCheck(s, scanned));
      if (r.status !== 200) {
        failed = true;
        return;
      }
      if (typeof r.body?.hold === "boolean") gatewayHeld = r.body.hold;
      roots.set(scanned.root, { ...roots.get(scanned.root), keys: now_, scanned }); // keep the gateway's pending set (R4-0)
      if (scanned.errors.length) await runCheck(s, scanned);
      return;
    }
    roots.set(scanned.root, { ...roots.get(scanned.root), keys: now_, scanned }); // keep the gateway's pending set (R4-0)
    // Something left: if the agent is held, a removal may be what lifts it.
    if (scanned.errors.length || (removed && state() === "held")) await runCheck(s, scanned);
  }

  /** Before a tool in session `s`: anything changed that no tool of this session wrote? */
  async function beforeTool(s) {
    await ensureChecked(s);
    const scanned = scan(s);
    if (!scanned) return;
    const before = roots.get(scanned.root);
    const now_ = scanned.files.flatMap((f) => f.keys);
    if (!before) return void (await runCheck(s, scanned));
    if (diffKeys(before.keys, now_).length === 0 && scanned.errors.length === (before.scanned?.errors.length ?? 0)) return;
    if (s.inflight > 0) {
      // A tool of this session is still running (parallel calls): its own write.
      return void (await afterTools(s, []));
    }
    await runCheck(s, scanned); // unattributed: it arrives, and holds before this tool runs
  }

  /** One hook event. Never throws; the hook's own answer is the gates'. */
  async function hook(input, { client = "claude-code", api = false } = {}) {
    try {
      if (!on()) return;
      const s = sessionOf(input);
      if (!s) return;
      // Which channel this session's harness really uses. Sticky the cautious way: one
      // non-API hook and the session can never be treated as withholdable.
      if (api) s.apiHook = true;
      else s.nonApi = true;
      if (client === "codex") s.client = "codex";
      const event = input.hook_event_name;
      if (event === "UserPromptSubmit") return void (await ensureChecked(s));
      if (event === "PreToolUse") {
        if (s.loading) await s.loading;
        touch(input);
        await beforeTool(s);
        s.inflight++;
        return;
      }
      if (event === "PostToolUse") {
        s.inflight = Math.max(0, s.inflight - 1);
        return void (await afterTools(s, [{ tool_name: input.tool_name, tool_input: input.tool_input }]));
      }
      if (event === "PostToolBatch") {
        const calls = Array.isArray(input.tool_calls) ? input.tool_calls : [];
        s.inflight = Math.max(0, s.inflight - Math.max(1, calls.length));
        return void (await afterTools(s, calls.map((c) => ({ tool_name: c?.tool_name, tool_input: c?.tool_input }))));
      }
    } catch {
      failed = true;
    }
  }

  /**
   * API mode: a model request on its way through the sidecar. The tool results it carries
   * are this session's "after"; its memory sections are what the model will actually read.
   */
  async function modelRequest(sessionId, body) {
    const s0 = DECLARED.test(String(sessionId ?? "")) ? sessionOf({ session_id: sessionId }) : null;
    const run = modelRequestInner(sessionId, body);
    // The next tool of this session waits for this check, however long it takes (R3-4).
    if (s0) s0.loading = run;
    try {
      return await run;
    } finally {
      if (s0 && s0.loading === run) s0.loading = null;
    }
  }
  async function modelRequestInner(sessionId, body) {
    try {
      if (!on()) return null;
      const s = DECLARED.test(String(sessionId ?? "")) ? sessionOf({ session_id: sessionId }) : null;
      if (!s) return mode === "withhold" ? withholdAll(body) : null; // no session to check for: nothing unverified goes through
      s.api = true;
      s.cwd ??= cwdFromRequest(body);
      if (!s.cwd) return mode === "withhold" ? withholdAll(body) : null;
      if (!s.checked) await ensureChecked(s);
      const uses = new Map();
      const results = new Set();
      for (const m of Array.isArray(body?.messages) ? body.messages : []) {
        for (const b of Array.isArray(m?.content) ? m.content : []) {
          if (m.role === "assistant" && b?.type === "tool_use" && typeof b.id === "string") uses.set(b.id, { tool_name: b.name, tool_input: b.input });
          if (m.role === "user" && b?.type === "tool_result" && typeof b.tool_use_id === "string") results.add(b.tool_use_id);
        }
      }
      const done = [...results].filter((id) => uses.has(id) && !s.seen.has(id));
      for (const id of done) {
        s.seen.add(id);
        if (s.seen.size > MAX_SEEN_TOOL_USES) s.seen.delete(s.seen.values().next().value);
      }
      if (done.length) {
        s.inflight = Math.max(0, s.inflight - done.length);
        await afterTools(s, done.map((id) => uses.get(id)));
      }
      // What Claude Code actually loaded. A section whose entries are not all on record is checked.
      const sections = requestMemorySections(body);
      const scanned = scan(s);
      if (!sections.length || !scanned) return mode === "withhold" ? withholdFor(s, body) : null;
      const known = new Set(roots.get(scanned.root)?.keys ?? []);
      const extra = [];
      for (const section of sections) {
        const disk = scanned.files.find((f) => f.path === section.path);
        const id = disk?.id ?? `import:abs:${section.path}`;
        const entries = memoryEntries(section.text);
        const keys = entryKeys(theSalt(), id, entries);
        // A truncated load (MEMORY.md past 200 lines) ends in a prefix of a disk entry: not new text.
        const novel = keys.filter((k, n) => !known.has(k) && !(disk?.entries ?? []).some((e) => e.text.startsWith(entries[n].text)));
        if (novel.length) extra.push({ fileKey: fileKey(theSalt(), id), label: disk?.label ?? "imported_file", keys: novel });
      }
      if (extra.length) await runCheck(s, scanned, extra);
      return mode === "withhold" ? withholdFor(s, body) : null;
    } catch {
      failed = true;
      return mode === "withhold" ? withholdAll(body) : null;
    }
  }

  // ── Direction 1: withhold ──────────────────────────────────────────────────

  /** The workspace a request belongs to: Claude Code's own "working directory" line, or a project instruction file's folder. */
  function cwdFromRequest(body) {
    const texts = [];
    if (typeof body?.system === "string") texts.push(body.system);
    else if (Array.isArray(body?.system)) for (const b of body.system) if (typeof b?.text === "string") texts.push(b.text);
    for (const t of texts) {
      const m = t.match(/(?:Primary working directory|Working directory|cwd):\s*(\/[^\s]+)/i);
      if (m) return m[1];
    }
    const home = env.HOME ?? "";
    for (const section of requestMemorySections(body)) {
      if (/\/(CLAUDE|AGENTS|CLAUDE\.local)\.md$/.test(section.path) && !(home && section.path.startsWith(`${home}/.claude/`))) return section.path.replace(/\/[^/]+$/, "");
    }
    return null;
  }

  /** Pending entries' text from this machine's last checked scans: what to cut from tool results, and what counts as residue. */
  function pendingText() {
    const lines = new Set();
    const clean = new Set();
    for (const { scanned, pending } of roots.values()) {
      for (const f of scanned.files) for (const e of f.entries) for (const l of e.text.split("\n")) (pending?.has(e.key) ? lines : clean).add(l.replace(/[ \t]+$/, ""));
    }
    const nonblank = [...lines].filter((l) => !/^[ \t]*$/.test(l));
    // Short or shared lines are ambiguous in ordinary tool output: do not cut them.
    // Hold instead, even before a read. Every cut candidate must also be long enough
    // for the residue probe (16 characters), so an uncut format cannot silently pass.
    const safe = (l) => !clean.has(l) && l.trim().length >= 16;
    const only = nonblank.filter(safe);
    return { stripLines: only, probes: only, requiresHold: nonblank.some((l) => !safe(l)) };
  }

  /** Nothing that this sidecar has not confirmed goes through: every memory section is cut. */
  function withholdAll(body) {
    const out = withholdRequest(body, { decide: () => "all", ...pendingText() });
    return out.sectionsChanged || out.linesWithheld ? out.body : null;
  }

  function withholdFor(s, body) {
    const root = roots.get(workspaceRoot(s.cwd));
    if (!root || failed) {
      s.residue ||= false;
      return withholdAll(body);
    }
    const checked = new Set(root.keys);
    const pending = root.pending ?? new Set();
    const out = withholdRequest(body, {
      ...pendingText(),
      decide: ({ path: p, entries }) => {
        const disk = root.scanned.files.find((f) => f.path === p);
        if (!disk) return "all"; // a file this machine has not checked
        const keys = entryKeys(theSalt(), disk.id, entries);
        const cut = new Set();
        keys.forEach((k, n) => {
          if (pending.has(k)) return void cut.add(n);
          if (checked.has(k)) return;
          // A truncated load ends in a prefix of a CLEAN disk entry: that is not new text. Only
          // the LAST entry of a section can be cut short; anywhere else a prefix is new text (R4-2).
          const prefixOfClean = n === entries.length - 1 && disk.entries.some((e) => !pending.has(e.key) && e.text.startsWith(entries[n].text));
          if (!prefixOfClean) cut.add(n);
        });
        return cut;
      },
    });
    if (out.residue > 0) {
      s.residue = true;
      onWarn("PassControl found memory waiting for review in a place it could not withhold it from, so this session's risky tools are held.");
    }
    return out.sectionsChanged || out.linesWithheld ? out.body : null;
  }

  /** A request this sidecar could not read in time or at all: cut every memory section, and hold its session. */
  function fallback(sessionId, body) {
    const s = DECLARED.test(String(sessionId ?? "")) ? sessionOf({ session_id: sessionId }) : null;
    if (s) s.residue = true;
    return body ? withholdAll(body) : null;
  }

  /**
   * For `passcontrol memory review`: what waits, with its text from THIS machine's files.
   * The gateway answers with hashes; the text never left and is matched here.
   */
  async function review(cwd, client = "claude-code") {
    if (!on()) return { state: mode === "off" ? "off" : "unknown", items: [] };
    const r = await call({ action: "pending" });
    if (r.status !== 200 || !Array.isArray(r.body?.entries)) return { state: "unavailable", items: [] };
    const scanned = scanMemory({ salt: theSalt(), cwd, agent: client, env, ownerPaths: paths, touchedDirs: [...touched], touchedFiles: [...touchedFiles] });
    const byKey = new Map(scanned.files.flatMap((f) => f.entries.map((e) => [e.key, { file: f.path, label: f.label, text: e.text, scope: e.scope }])));
    const items = r.body.entries
      .filter((e) => e && typeof e.key === "string")
      .map((e) => ({ ...e, local: byKey.get(e.key) ?? null }));
    return { state: state(), items };
  }

  return { hook, modelRequest, fallback, mode: () => mode, setView, state, review, _debug: { sessions, roots } };
}

export { workspaceRoot };
