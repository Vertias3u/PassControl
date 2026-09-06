// Audit-log writes (service role). agent_logs is the append-only source of truth;
// agents.spent_* is a best-effort mirror for the dashboard.
import { serviceClient } from "./supabase";
import { captureError } from "./observability";

interface LogEntryBase {
  // Supplied by the proxy so the receipt id can go in a response header before
  // this row exists. Omitted elsewhere, where the DB default is fine.
  id?: string;
  // Detached EdDSA JWS over this call, verifiable by a third party against
  // /.well-known/jwks.json. Null when the deployment configures no signing key.
  // Written in the SAME insert as the row: migration 0006 rejects UPDATE on
  // agent_logs at depth 1 even for service_role, so it cannot be filled in later.
  receipt?: string | null;
  agentId: string;
  userId: string | null;
  /**
   * The budget attempt this row accounts for. Its whole job is to let the
   * operator-recovery insert in the hold-resolve route bounce off a UNIQUE index
   * when the proxy already wrote a row for the same attempt — see migration
   * 0056. Omit it and that dedup silently stops working, because a NULL is
   * distinct from every other NULL in a unique index.
   */
  attemptId?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  // `null` means the cost is UNKNOWN, which is not the same as zero: a custom
  // endpoint cannot be priced, and `agent_logs.cost_microcents` has always been
  // nullable to say so. Every surface that renders it already treats null as
  // "no recorded cost" rather than as free.
  costMicrocents?: number | null;
  /**
   * True when nobody could price this call — see `unpriced` in lib/receipt.ts
   * and `isPricedEndpoint` in lib/pricing.ts.
   *
   * NOT a duplicate of `costMicrocents: null`. The proxy has recorded null for
   * an unpriced call since the unknown-cost work, but null is ambiguous: a
   * BLOCKED call also has no recorded cost, and it is not unpriced — there was
   * simply nothing to price. Both kinds of row carry a receipt and therefore
   * both land in a spend statement's Merkle tree, so a statement that could not
   * tell them apart would report "3 calls we could not price" for three calls it
   * refused. This says which.
   *
   * ONLY THE POSITIVE ASSERTION IS WRITTEN. `false` is left absent, so a priced
   * call's row is byte-identical to what this wrote before the column existed —
   * which is what keeps the conditional spread below safe on a pre-0053 schema.
   * A statement derives "priced" from `cost_microcents is not null` instead, and
   * counts a row with neither as pricing-unknown.
   */
  unpriced?: boolean;
  // blocked_killed vs blocked_suspended distinguishes the kill switch (platform,
  // tenant, or denylist) from a per-agent suspend. Both answer 403
  // "blocked_suspended" on the wire — the split exists only here, for the audit
  // trail. agent_logs.status is plain text, so no migration gates a new value.
  status:
    | "ok"
    | "blocked_budget"
    | "blocked_endpoint"
    | "blocked_killed"
    | "blocked_suspended"
    | "blocked_scope"
    | "blocked_policy"
    // Distinct from blocked_budget, which is PassControl's OWN budget refusing
    // the call before it went anywhere. This one means the gateway allowed it,
    // forwarded it, and the provider answered that the account has no credit.
    // Same money, opposite party, opposite fix — an operator who confuses them
    // goes and raises a budget that was never the problem.
    | "provider_exhausted"
    // Neither of the above. The gateway refused BEFORE forwarding, because no
    // provider key is stored for this provider — there was nothing to inject.
    // The provider never saw the call, so reporting it as an upstream failure
    // sends the operator to debug an account that was never contacted. The
    // actual fix is one step in this product: store the key.
    | "no_provider_key"
    // The gateway refused before forwarding because it could not find out WHERE
    // this credential goes: the endpoint read failed, and a failed read is not
    // the same answer as "no endpoint set". Distinct from upstream_error for the
    // same reason no_provider_key is — the provider never saw this call, and
    // reporting it as an upstream failure sends the operator to debug an account
    // that was never contacted. The fix here is the database, not the provider.
    | "endpoint_unavailable"
    | "upstream_error"
    // The call was forwarded and MAY have been billed, but no usage ever
    // arrived — a stream that broke, a stream that closed cleanly without ever
    // reporting usage, a dispatch that got no answer. Distinct from `ok`
    // because it is not a confirmed accounting, and distinct from
    // `upstream_error` because the money question is the opposite one: an
    // upstream error is a call we know produced nothing, this is a call we
    // cannot say that about.
    //
    // It COUNTS TOWARD SPEND (db/migrations/0055): the attempt was charged at
    // max(observed, estimate), and a checkpoint that omitted it would hand the
    // capacity back at the next cron run.
    | "usage_unknown"
    // The gateway refused BEFORE forwarding because its own budget counters for
    // this agent were lost and it declines to invent a starting balance.
    //
    // NOT a budget denial, and the two must never be conflated. `blocked_budget`
    // means the agent is out of money and answers 402; an agent reads that as
    // final and stops retrying. This is an operator-recoverable infrastructure
    // fault, answers 503, and is fixed by a rebuild — not by raising a cap.
    | "blocked_budget_state"
    // The attempt could not obtain its one-use dispatch permission, so it was
    // never sent. A sibling of blocked_budget_state, not of blocked_budget:
    // both are the gateway declining to act on accounting state it cannot
    // vouch for, and both answer 503. The distinction from
    // blocked_budget_state is WHICH state was unreadable — the agent's
    // counters there, this one attempt's dispatch record here — and it matters
    // because this one means another handler may hold this attempt's single
    // send and be inside the provider call right now.
    | "dispatch_unavailable";
  /**
   * What the budget was actually CHARGED for this attempt, when that differs
   * from the observed figures above.
   *
   * Not a correction of `inputTokens`/`outputTokens`/`costMicrocents`, and must
   * never be read as one. A stream that broke after reporting 40 tokens really
   * did report 40 tokens; what the gateway charged it was max(40, estimate),
   * because the provider may have billed for work nobody could measure. Both
   * numbers are true and they answer different questions.
   *
   * WRITTEN ONLY WHEN THEY DIFFER, and omitted otherwise — the same conditional
   * spread as `receipt`, `policy_shadow_would`, `sender_proof_would` and
   * `unpriced`, for the same reason: PostgREST rejects the WHOLE insert on an
   * unknown column, so a deployment running this code against a pre-0055 schema
   * would write NO audit rows at all, silently, on every call.
   */
  enforcedTokens?: number;
  enforcedMicrocents?: number;
  latencyMs?: number;
  // What a shadow policy WOULD have decided for this call ("allow" /
  // "deny:policy"). Absent when the agent has no shadow policy, or when the
  // shadow evaluation reached no verdict about the policy step.
  policyShadowWould?: string;
  // What the sender-proof check found while the agent was in OBSERVE mode
  // ("pass" / "missing" / "invalid" / "clock_skew" / "replayed"). Absent in
  // every other mode, and absent for a Direct Agent Key. It decides nothing:
  // the call was admitted whatever it says, and `authMethod` stays `passport`
  // — see db/migrations/0049.
  senderProofWould?: string;
}

export type AuthMethod = "passport" | "passport_proof_per_request" | "direct_key";

type PassportLogIdentity = {
  /** Omitted keeps the passport writer compatible with the expansion migration. */
  authMethod?: Exclude<AuthMethod, "direct_key">;
  passportId: string;
  jti: string;
  agentAccessKeyId?: never;
  credentialUseId?: never;
};

type DirectKeyLogIdentity = {
  authMethod: "direct_key";
  passportId?: never;
  jti?: never;
  agentAccessKeyId: string;
  credentialUseId: string;
};

export type LogEntry = LogEntryBase & (PassportLogIdentity | DirectKeyLogIdentity);

export async function writeLog(entry: LogEntry): Promise<void> {
  const db = serviceClient();
  // Record annotation prevents the direct/passport identity branch from
  // becoming a structural UNION at the Supabase call. PostgREST receives one
  // ordinary object; the discriminated LogEntry type is what proves its shape.
  const row: Record<string, unknown> = {
    ...(entry.id ? { id: entry.id } : {}),
    // Omitted entirely when there is no receipt, rather than sent as null.
    //
    // This is what decouples the code from migration 0016. PostgREST rejects the
    // WHOLE insert if a named column does not exist, so sending `receipt: null`
    // unconditionally would mean a deployment running this code against a
    // pre-0016 schema writes NO audit rows at all — silently, on every call,
    // since agent_logs writes are best-effort. Omitting the key keeps a
    // deployment that has not enabled receipts byte-identical to before.
    // A deployment that DOES set INSTANCE_SIGNING_KEY must run 0016 first.
    ...(entry.receipt ? { receipt: entry.receipt } : {}),
    // Omitted when absent for exactly the reason above, one migration later:
    // PostgREST rejects the whole insert on an unknown column, so naming this
    // unconditionally would mean a deployment running this code against a
    // pre-0020 schema writes NO audit rows at all — silently, on every call.
    // Shadow mode is diagnostics; it must not be able to cost the audit trail.
    ...(entry.policyShadowWould ? { policy_shadow_would: entry.policyShadowWould } : {}),
    // Conditional for exactly the reason above, one migration later: a
    // deployment running this code against a pre-0049 schema must still write
    // its audit rows. Observation must never be able to cost the audit trail.
    ...(entry.senderProofWould ? { sender_proof_would: entry.senderProofWould } : {}),
    // Conditional for exactly the reason above, one migration later: a
    // deployment running this code against a pre-0053 schema must still write
    // its audit rows, and PostgREST rejects the whole insert on an unknown
    // column. Omitted for a PRICED call as well as an unrecorded one, so a
    // priced row is byte-identical to what this wrote before the column existed
    // — absence already means "not known to be unpriced", and sending `false`
    // would claim the opposite of what an unmigrated writer's absence means.
    ...(entry.unpriced ? { unpriced: true } : {}),
    // Conditional for exactly the reason above, one migration later (0055).
    // `!= null` rather than truthiness: an enforced ZERO is a real answer — it
    // is what an undispatched attempt records — and dropping it would leave the
    // row claiming the observed figure was enforced when nothing was.
    // Conditional for exactly the reason above, one migration later (0056).
    ...(entry.attemptId ? { attempt_id: entry.attemptId } : {}),
    ...(entry.enforcedTokens != null ? { enforced_tokens: Math.round(entry.enforcedTokens) } : {}),
    ...(entry.enforcedMicrocents != null
      ? { enforced_microcents: Math.round(entry.enforcedMicrocents) }
      : {}),
    agent_id: entry.agentId,
    user_id: entry.userId,
    ...(entry.authMethod === "direct_key"
      ? {
          auth_method: "direct_key",
          agent_access_key_id: entry.agentAccessKeyId,
          credential_use_id: entry.credentialUseId,
          passport_id: null,
          jti: null,
        }
      : {
          // Ordinary passport rows keep taking the long-standing database
          // default. The stronger value must be explicit: it is a statement
          // about a proof this request actually passed, not an identity default.
          ...(entry.authMethod === "passport_proof_per_request"
            ? { auth_method: "passport_proof_per_request" }
            : {}),
          passport_id: entry.passportId,
          jti: entry.jti,
        }),
    provider: entry.provider ?? null,
    model: entry.model ?? null,
    input_tokens: entry.inputTokens ?? null,
    output_tokens: entry.outputTokens ?? null,
    cost_microcents: entry.costMicrocents != null ? Math.round(entry.costMicrocents) : null,
    status: entry.status,
    latency_ms: entry.latencyMs ?? null,
  };
  // One immediate retry covers transient PostgREST failures. If both attempts
  // fail, capture a generic error with identifiers only; never include request
  // bodies, credentials, or provider-key material in observability payloads.
  const isDuplicate = (e: unknown) => (e as { code?: string } | null)?.code === "23505";

  let { error } = await db.from("agent_logs").insert(row);
  // A duplicate on the FIRST attempt is not a lost response: something else
  // already wrote this id, which means reconcile ran twice. Don't retry it, and
  // don't swallow it — that is precisely the bug worth surfacing.
  if (error && !isDuplicate(error)) {
    ({ error } = await db.from("agent_logs").insert(row));
    // A duplicate on the RETRY means our own first insert actually landed and
    // only its response was lost. The row is there, so this is a success.
    // Reachable only since the caller started supplying `id`.
    if (isDuplicate(error)) return;
  }
  if (error) {
    await captureError(new Error("agent log insert failed after retry"), {
      route: "lib.log.writeLog",
      method: "INSERT",
      status: 500,
      agentId: entry.agentId,
      jti: entry.authMethod === "direct_key" ? entry.credentialUseId : entry.jti,
      provider: entry.provider,
      code: "agent_log_insert_failed",
    });
  }
}

/** Best-effort mirror of cumulative spend onto the agents row. Cost is in µ¢. */
export async function mirrorSpend(
  agentId: string,
  addTokens: number,
  addMicrocents: number
): Promise<void> {
  const db = serviceClient();
  const params = {
    p_agent_id: agentId,
    p_tokens: addTokens,
    p_microcents: Math.round(addMicrocents),
  };
  let { error } = await db.rpc("increment_agent_spend", params);
  if (error) ({ error } = await db.rpc("increment_agent_spend", params));
  if (error) {
    await captureError(new Error("agent spend mirror failed after retry"), {
      route: "lib.log.mirrorSpend",
      method: "RPC",
      status: 500,
      agentId,
      code: "spend_mirror_failed",
    });
  }
}
