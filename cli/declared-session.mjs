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
 * @param {(name: string) => string | null | undefined} header  lower-case header lookup
 * @param {string} runId  this sidecar run's id
 */
export function declaredSession(header, runId) {
  const claude = declared(header("x-claude-code-session-id"));
  if (claude) return claude;

  const isCodex =
    /^codex/i.test(header("originator") ?? "") ||
    header("x-codex-turn-metadata") != null ||
    header("x-codex-window-id") != null ||
    header("x-codex-parent-thread-id") != null;
  if (isCodex) {
    const raw = [header("session-id"), header("session_id")].filter((v) => v !== null && v !== undefined);
    if (raw.length > 0 && raw.every((v) => declared(v) !== null) && raw.every((v) => v === raw[0])) return raw[0];
  }

  return declared(runId);
}
