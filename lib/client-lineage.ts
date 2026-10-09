// Which working session, and which sub-agent within it, a call says it came from.
//
// Claude Code and Codex already send this with every request. Read from real
// requests (tests/fixtures/{claude-code,codex}/subagent-*.json, 2026-10-08):
//
//   Claude Code   x-claude-code-session-id        every call
//                 x-claude-code-agent-id          sub-agents only; the main agent has none
//                 x-claude-code-parent-agent-id   only a sub-agent's OWN sub-agent. A
//                                                 first-level sub-agent sends no parent:
//                                                 its parent is the main agent.
//   Codex         session-id (session_id, or the body's client_metadata.session_id)
//                 thread-id                       the root thread equals the session
//                 x-codex-parent-thread-id        spawned threads; for a first-level
//                 x-openai-subagent               child it is the root thread
//
// The result uses ONE shape for both: `agent: null` is the main agent, and
// `parent: null` means "spawned by the main agent". So a Codex parent that is the
// root thread reads as null, the same way Claude Code never names it.
//
// ── What this is NOT ─────────────────────────────────────────────────────────
//
// Every value here is DECLARED by the client. The sidecar holds the only key and
// every sub-agent's call goes through the same port, so any local process can send
// any of these headers. They identify a call for the log and the receipt; they
// must never authenticate one, and a receipt carrying them says `src: "declared"`.
//
// A value that is not `[A-Za-z0-9._:-]{1,128}` is dropped silently: "not declared",
// never an error and never a refusal. A lineage header must not be able to break a
// call, and nothing that could start a new header line or a log line survives.
//
// Pure: no I/O, no route imports this yet (sprint Q2).

export type ClientLineage = {
  /** Who declared `session`: the CLI itself, or the sidecar's per-run id. */
  kind: "claude-code" | "codex" | "sidecar";
  session: string;
  /** The sub-agent. null is the main agent. */
  agent: string | null;
  /** The sub-agent that spawned `agent`. null is the main agent. */
  parent: string | null;
};

type HeaderSource = { get(name: string): string | null };

const DECLARED = /^[A-Za-z0-9._:-]{1,128}$/;

/** The value if it is a well-formed declaration, else null. */
function declared(value: unknown): string | null {
  return typeof value === "string" && DECLARED.test(value) ? value : null;
}

/**
 * One value the client may state in several places. Absent everywhere is null;
 * two different statements are null too: a client that contradicts itself has
 * not declared a session.
 */
function agreed(...values: (string | null)[]): string | null {
  const stated = values.filter((v): v is string => v !== null);
  if (stated.length === 0) return null;
  return stated.every((v) => v === stated[0]) ? stated[0]! : null;
}

function claudeCode(h: HeaderSource): ClientLineage | null {
  const session = declared(h.get("x-claude-code-session-id"));
  if (!session) return null;
  const agent = declared(h.get("x-claude-code-agent-id"));
  // A parent with no agent describes nobody.
  const parent = agent ? declared(h.get("x-claude-code-parent-agent-id")) : null;
  return { kind: "claude-code", session, agent, parent };
}

function codexSession(h: HeaderSource, body: unknown): string | null {
  const raw = [h.get("session-id"), h.get("session_id")];
  const meta = typeof body === "object" && body !== null ? (body as { client_metadata?: unknown }).client_metadata : undefined;
  const fromBody =
    typeof meta === "object" && meta !== null && !Array.isArray(meta) ? (meta as { session_id?: unknown }).session_id : undefined;
  const all = [...raw, fromBody].filter((v) => v !== null && v !== undefined);
  // One malformed statement spoils the set: a client that sends one good and one
  // bad session id has not said which one it meant.
  if (all.some((v) => declared(v) === null)) return null;
  return agreed(...all.map(declared));
}

function codex(h: HeaderSource, body: unknown): ClientLineage | null {
  // A bare `session-id` header is not enough to call a client Codex: other clients
  // could send one. Codex always sends `originator` (codex_exec, codex_cli_rs, …)
  // and `x-codex-*` headers.
  const isCodex =
    /^codex/i.test(h.get("originator") ?? "") ||
    h.get("x-codex-turn-metadata") !== null ||
    h.get("x-codex-window-id") !== null ||
    h.get("x-codex-parent-thread-id") !== null;
  if (!isCodex) return null;
  const session = codexSession(h, body);
  if (!session) return null;
  const spawned = h.get("x-codex-parent-thread-id") !== null || h.get("x-openai-subagent") !== null;
  const agent = spawned ? declared(h.get("thread-id")) : null;
  const parentThread = agent ? declared(h.get("x-codex-parent-thread-id")) : null;
  return { kind: "codex", session, agent, parent: parentThread === session ? null : parentThread };
}

/**
 * The lineage a call declares, or null when it declares none.
 *
 * The CLI's own session wins over the sidecar's run id (`x-passcontrol-run`): one
 * sidecar can serve Claude Code and Codex at once, so the run id is the coarser
 * grouping. When the CLI's session is missing or malformed the run id stands in,
 * WITHOUT the CLI's agent ids, which name agents inside a session we could not read.
 */
export function readClientLineage(headers: HeaderSource, body?: unknown): ClientLineage | null {
  const cli = claudeCode(headers) ?? codex(headers, body);
  if (cli) return cli;
  const run = declared(headers.get("x-passcontrol-run"));
  return run ? { kind: "sidecar", session: run, agent: null, parent: null } : null;
}
