// Which passport door a signed proof is for (cloud review 2026-11-03, CP5).
//
// /api/auth/challenge, /api/auth/delegated and /api/auth/agent-token all take the
// same signed {passport_id, ts, nonce}. Until this, a proof good at one was good at
// all three, so a relay that saw a body meant for one door could spend it at
// another: an agent-token body taken to the challenge mints a VISA, a credential
// with the agent's scope and budget, from a proof the agent signed to talk to a
// counterparty.
//
// The signature covers the payload bytes, so a field inside them cannot be
// stripped or changed in transit. Two rules, both read from the signed payload:
//   - `purpose`, when present, must name THIS door. Clients from this release on
//     sign it; a proof without one (every older client) is judged by the next rule.
//   - `aud` is the agent-token door's own field, which it requires. A payload
//     carrying it is an agent-token proof whatever else it says, so the visa doors
//     refuse it. That closes the relay above for every client, old or new.
// Left open for older clients only: a purpose-less proof moving between the
// challenge and the delegated door. The delegated door also demands a chain whose
// leaf signed the proof, which a relay cannot invent.
export type ProofPurpose = "challenge" | "delegated" | "agent-token";

/** True when this signed payload was not made for `door`. */
export function wrongProofPurpose(payload: Record<string, unknown>, door: ProofPurpose): boolean {
  if ("purpose" in payload && payload.purpose !== door) return true;
  if (door !== "agent-token" && "aud" in payload) return true;
  return false;
}
