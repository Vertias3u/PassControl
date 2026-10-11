// What the operator is told when a stop changed in Redis but not in its durable
// record (0083). Redis is what refuses calls, so the change IS in force; what is
// missing is the copy that survives Redis losing its data. One wording for the
// fleet switch, the per-service stops and the session stops.
//
// Each control pairs this with a retry that re-sends the SAME intent (every
// stop is a desired state, so a repeat is safe). Not "press it again": the one
// button beside a stopped control is the one that lifts it.

export function notDurableMessage(armed: boolean): string {
  return armed
    ? "In force, but not saved to the database: if Redis loses its data, this stop is lifted."
    : "Lifted, but the saved stop could not be cleared: if Redis loses its data, this stop comes back.";
}

export function notDurableRetryLabel(armed: boolean): string {
  return armed ? "Try saving again" : "Try clearing again";
}
