// The local stack's addresses as a function of the port offset `setup` was
// given. One definition for setup and everything that reads its result, so a
// second install (`setup --port-offset N`) moves as a whole: Supabase, Redis
// (scripts/dev-stack.sh) and the dashboard.

/** The canonical local dashboard port, used when no offset was given. */
export const LOCAL_DASHBOARD_PORT = 3000;

/** The same bounds setup enforces on --port-offset. */
function assertOffset(offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000) {
    throw new Error("--port-offset must be an integer from 0 to 10000.");
  }
}

/** The local dashboard origin for a stack set up with this port offset. */
export function dashboardOriginForOffset(offset) {
  assertOffset(offset);
  return `http://localhost:${LOCAL_DASHBOARD_PORT + offset}`;
}
