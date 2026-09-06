// Compatibility vocabulary shared by the Control API and the standalone CLI.
// The CLI ships without the Next app, so this plain ESM module is the canonical
// runtime source; its declaration lets Edge TypeScript import the same values.
export const CONTROL_API_PROTOCOL = { minimum: 1, maximum: 1 };
export const GATEWAY_API_PROTOCOL = { minimum: 1, maximum: 1 };
export const RECEIPT_PROTOCOL = { minimum: 1, maximum: 2 };
export const AGENT_TOKEN_PROTOCOL = { minimum: 1, maximum: 1 };
export const WORKSPACE_EXPORT_PROTOCOL = { minimum: 1, maximum: 1 };

/**
 * Signed spend statements. Its OWN version line, deliberately separate from the
 * receipt's: a statement carries `v` where a receipt carries `ver`, and gating
 * one on the other's maximum would let a statement claiming the receipt's
 * current version (2) through a verifier that only understands statement v1.
 *
 * IN CLIENT_PROTOCOLS below, as of the scope split. It was deliberately absent
 * while nothing negotiated it, but the statement format is now a published
 * contract — docs/statement-format.md is written for someone implementing a
 * verifier from scratch — and a published contract that the compatibility
 * handshake does not report is a version number nobody can act on.
 *
 * KNOWN CONSEQUENCE, ACCEPTED. `compareProtocolSets` walks every key here, and
 * a server that does not declare `statement` scores "unavailable", which makes
 * the overall verdict unavailable. So this CLI reports incompatibility against
 * any gateway predating the declaration. That is the honest answer rather than
 * a regression — `passcontrol statements` genuinely does not work there — but
 * it means a self-hoster who upgrades the CLI before their gateway will see it,
 * and the release note has to say so.
 */
export const STATEMENT_PROTOCOL = { minimum: 1, maximum: 1 };

export const CLIENT_PROTOCOLS = Object.freeze({
  control_api: CONTROL_API_PROTOCOL,
  gateway_api: GATEWAY_API_PROTOCOL,
  receipt: RECEIPT_PROTOCOL,
  agent_token: AGENT_TOKEN_PROTOCOL,
  workspace_export: WORKSPACE_EXPORT_PROTOCOL,
  statement: STATEMENT_PROTOCOL,
});

const validRange = (value) =>
  value &&
  Number.isInteger(value.minimum) &&
  Number.isInteger(value.maximum) &&
  value.minimum >= 1 &&
  value.minimum <= value.maximum;

/**
 * Compare negotiated version ranges without pretending a missing or malformed
 * server declaration is compatible. A non-identical overlap is useful but
 * partial: an operator should know the pair is not speaking precisely the same
 * contract before relying on a newer optional feature.
 */
export function compareProtocolRanges(client, server) {
  if (!validRange(server)) return "unavailable";
  // A server declaring a higher maximum may emit semantics this CLI cannot
  // interpret, even when the numeric ranges overlap. Do not dress that up as
  // partial compatibility. Conversely, an older server inside our maximum can
  // still serve the shared contract and is merely partial.
  if (
    server.maximum > client.maximum ||
    server.maximum < client.minimum
  ) return "update-required";
  if (server.minimum !== client.minimum || server.maximum !== client.maximum) return "partial";
  return "compatible";
}

export function compareProtocolSets(serverProtocols) {
  const checks = Object.entries(CLIENT_PROTOCOLS).map(([name, client]) => ({
    name,
    client,
    server: serverProtocols?.[name],
    state: compareProtocolRanges(client, serverProtocols?.[name]),
  }));
  const states = checks.map((check) => check.state);
  const state = states.includes("update-required")
    ? "update-required"
    : states.includes("unavailable")
      ? "unavailable"
      : states.includes("partial")
        ? "partial"
        : "compatible";
  return { state, checks };
}
