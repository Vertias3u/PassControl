// The session a relayed call declares, exactly as the gateway reads it from the request
// headers (lib/client-lineage.ts `readClientLineage`, which the proxy calls without the
// body): Claude Code's session header, else a Codex session its headers agree on, else
// this sidecar run's own id (`x-passcontrol-run`, which the sidecar sets on every call).
//
// A second copy because the sidecar is plain ESM and cannot import the gateway's
// TypeScript. tests/declared-session-parity.test.ts runs both over every captured
// Claude Code and Codex request and fails the day they disagree: the journal is
// filtered by this value, so a mismatch could hide a real omission.

const DECLARED = /^[A-Za-z0-9._:-]{1,128}$/;
const declared = (value) => (typeof value === "string" && DECLARED.test(value) ? value : null);

/**
 * The session a call declares, and the sub-agent inside it: what `passcontrol watch`
 * puts on a call's row (F6). The gateway's own rules, mirrored: the CLI's agent ids
 * count only next to the CLI's own session; when the run id stands in, they name
 * agents inside a session we could not read, so they are dropped, and the client's
 * own `x-passcontrol-agent` / `x-passcontrol-parent` are read instead. A parent with
 * no agent describes nobody.
 *
 * @param {(name: string) => string | null | undefined} header  lower-case header lookup
 * @param {string} runId  this sidecar run's id
 * @returns {{ session: string, agent: string | null, parent: string | null } | null}
 */
export function declaredLineage(header, runId) {
  const claude = declared(header("x-claude-code-session-id"));
  if (claude) {
    const agent = declared(header("x-claude-code-agent-id"));
    return { session: claude, agent, parent: agent ? declared(header("x-claude-code-parent-agent-id")) : null };
  }

  const isCodex =
    /^codex/i.test(header("originator") ?? "") ||
    header("x-codex-turn-metadata") != null ||
    header("x-codex-window-id") != null ||
    header("x-codex-parent-thread-id") != null;
  if (isCodex) {
    const raw = [header("session-id"), header("session_id")].filter((v) => v !== null && v !== undefined);
    if (raw.length > 0 && raw.every((v) => declared(v) !== null) && raw.every((v) => v === raw[0])) {
      const session = raw[0];
      const spawned = header("x-codex-parent-thread-id") != null || header("x-openai-subagent") != null;
      const agent = spawned ? declared(header("thread-id")) : null;
      const parentThread = agent ? declared(header("x-codex-parent-thread-id")) : null;
      return { session, agent, parent: parentThread === session ? null : parentThread };
    }
  }

  const run = declared(runId);
  if (!run) return null;
  const agent = declared(header("x-passcontrol-agent"));
  return { session: run, agent, parent: agent ? declared(header("x-passcontrol-parent")) : null };
}

/**
 * @param {(name: string) => string | null | undefined} header  lower-case header lookup
 * @param {string} runId  this sidecar run's id
 */
export function declaredSession(header, runId) {
  return declaredLineage(header, runId)?.session ?? null;
}
