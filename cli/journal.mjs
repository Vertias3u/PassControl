// The sidecar's journal: the user's own list of the receipt ids their calls produced.
//
// WHY IT EXISTS. A session seal (`passcontrol verify session`) proves the issuer
// committed to a set of receipts. The journal is what lets the user check that set
// against an INDEPENDENT record: every id here must be in the seal's bundle, so a
// call left out of the seal is caught. Without it a seal is no stronger than a
// statement (sdk/verify.ts, verifySession).
//
// WHAT IT HOLDS: one JSON line per relayed call — `{ id, t, s }`, the receipt id,
// the time in epoch milliseconds, and the HTTP status. Nothing else, ever: no
// prompt, no model, no header, no body. The id is already shown to the client in
// `x-passcontrol-receipt-id`; the journal only keeps it.
//
// One file per sidecar run, named by start time and run id, owner-only (0600 in a
// 0700 directory). Created on the first call that returns a receipt, so a sidecar
// that relays nothing leaves nothing behind. On by default; `--no-journal` turns it
// off (D3, 2026-10-08).
//
// A journal failure NEVER breaks a call: the call has already happened, and the
// worst a lost line can do is make a later seal check report that receipt as
// "in the seal, not in your journal", which is never a failure. It warns once.
import fs from "node:fs";
import path from "node:path";
import { globalConfigPath } from "./config.mjs";

const RECEIPT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** `<config dir>/journal`, beside the CLI's own config file. */
export function defaultJournalDir(env = process.env) {
  return path.join(path.dirname(globalConfigPath(env)), "journal");
}

/** `2026-10-08T03-21-00Z`: sortable, and legal in a filename on every platform. */
function stamp(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

export function openJournal({ dir = defaultJournalDir(), runId, now = Date.now, onError = () => {} }) {
  const file = path.join(dir, `${stamp(now())}-${runId}.jsonl`);
  let fd = null;
  let broken = false;

  function ensureOpen() {
    if (fd !== null) return fd;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is filtered by the umask, and an existing directory keeps
    // whatever it had. This one holds a record of the user's calls: owner-only.
    fs.chmodSync(dir, 0o700);
    fd = fs.openSync(file, "a", 0o600);
    fs.fchmodSync(fd, 0o600);
    return fd;
  }

  return {
    path: file,
    /**
     * Record one relayed call. Never throws. `session` is the session the call
     * declared (cli/declared-session.mjs): one sidecar run serves many sessions, and
     * a seal is checked against its own session's lines only.
     */
    record(id, status, session) {
      if (broken || typeof id !== "string" || !RECEIPT_ID.test(id)) return;
      try {
        const entry = { id, t: now(), s: Number.isInteger(status) ? status : 0 };
        if (typeof session === "string" && RECEIPT_ID.test(session)) entry.ses = session;
        const line = JSON.stringify(entry) + "\n";
        fs.writeSync(ensureOpen(), line);
      } catch (e) {
        broken = true;
        onError(e);
      }
    },
    close() {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Already closed, or the process is exiting: nothing to keep.
        }
        fd = null;
      }
    },
  };
}
