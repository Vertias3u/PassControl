// POST /api/control/v1/workspace/import — restore workspace CONFIGURATION from
// an export file (write scope). The only write path this feature adds.
//
// Two properties hold it together:
//
//   Additive. An agent the tenant already holds is left completely untouched —
//   never updated, never re-pointed. So a re-run creates nothing new, which
//   makes the import naturally retry-safe and is why it carries no
//   Idempotency-Key: there is no partial application a retry could double.
//
//   Previewed by the same planner and semantics that apply. `?dry_run=true`
//   stops before writes; concurrent registrations can still change the final
//   report, so apply is authoritative and records each resulting race honestly.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { readJsonBody } from "@/lib/control/body";
import { recordAdminAction } from "@/lib/audit";
import { planAgentImports, planOwnershipImport, summarizePlan } from "@/lib/workspace-import";

// The body cap in lib/control/body.ts is 64 KiB and is shared by every
// control-plane route, so it is not raised for this one. The CLI therefore
// sends only what the import writes, and checks the size before sending so the
// operator gets "import in slices", not a bare 413.
const MAX_IMPORT_AGENTS = 200;

// Old deployments surface the current-key constraint as 23505. Once 0035 is
// applied, the global current-and-retired namespace raises this stable internal
// token instead. Both mean a transaction lost the identity reservation race and
// require the same tenant-scoped verification before the report names a cause.
function passportKeyConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const row = error as { code?: unknown; message?: unknown };
  return row.code === "23505" || (typeof row.message === "string" && row.message.includes("passport_key_in_use"));
}

const handler = control("write", async ({ req, userId, db, keyId, requestId }) => {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return errorResponse(parsed.status, parsed.code, requestId);

  // Accepts the slim payload the CLI sends and, unchanged, the `workspace`
  // block of a full export file — someone curling their own export at this
  // route should not have to reshape it first. Only these two keys are ever
  // read; a provider credential or a break-glass grant sitting beside them in
  // the file is not addressed by any code below.
  const body = parsed.body ?? {};
  const source = body.workspace ?? body;
  const agents = source.agents;
  const ownership = source.ownership;

  if (Array.isArray(agents) && agents.length > MAX_IMPORT_AGENTS) {
    return errorResponse(413, "payload_too_large", requestId);
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry_run") === "true";

  // The collision set. `db` is the service client, which bypasses RLS, so this
  // `.eq("user_id", userId)` is the only thing keeping another tenant's
  // passports out of the comparison.
  const { data: held, error: heldError } = await db
    .from("agents")
    .select("passport_pubkey")
    .eq("user_id", userId);
  if (heldError) return errorResponse(500, "query_failed", requestId);

  const { data: owner, error: ownerError } = await db
    .from("agent_owners")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (ownerError) return errorResponse(500, "query_failed", requestId);

  let plan = planAgentImports(
    agents,
    (held ?? []).map((row) => (row as { passport_pubkey: string }).passport_pubkey)
  );

  // `agents.passport_pubkey` is globally unique, and a retired passport is
  // reserved by the same namespace while its grace state remains on a row. A
  // caller-scoped read cannot answer whether a create candidate collides with
  // either kind of key somewhere else, but an unscoped service-role agents read
  // would leak cross-tenant identity data. The database exposes only this
  // service-role availability answer; the trigger that owns the namespace is
  // still the authoritative race-safe enforcement on apply.
  const candidateKeys = plan
    .filter((item): item is Extract<typeof item, { action: "create" }> => item.action === "create")
    .map((item) => item.passportPubkey);
  if (candidateKeys.length > 0) {
    const { data: availabilityRows, error: availabilityError } = await db.rpc("passport_key_availability", {
      p_passport_pubkeys: candidateKeys,
    });
    if (availabilityError || !Array.isArray(availabilityRows)) {
      return errorResponse(500, "query_failed", requestId);
    }
    const availability = new Map<string, boolean>();
    for (const row of availabilityRows) {
      if (!row || typeof row !== "object") continue;
      const value = row as { passport_pubkey?: unknown; available?: unknown };
      if (typeof value.passport_pubkey === "string" && typeof value.available === "boolean") {
        availability.set(value.passport_pubkey, value.available);
      }
    }
    // A missing/malformed result is not permission to create. It is an
    // unavailable dependency, so fail the request rather than turn uncertainty
    // into an optimistic preview that apply will later contradict.
    if (candidateKeys.some((key) => !availability.has(key))) {
      return errorResponse(500, "query_failed", requestId);
    }
    const unavailableKeys = candidateKeys.filter((key) => availability.get(key) === false);
    if (unavailableKeys.length > 0) {
      // Availability is a snapshot, and the caller's first held-key read
      // happened before it. A same-tenant create can land in that interval, so
      // `available: false` proves only that the key is now reserved — not who
      // reserved it. One tenant-scoped batch read distinguishes a safe retry
      // skip from a cross-tenant refusal without expanding the availability RPC
      // into an ownership oracle.
      const { data: nowHeld, error: nowHeldError } = await db
        .from("agents")
        .select("passport_pubkey")
        .eq("user_id", userId)
        .in("passport_pubkey", unavailableKeys);
      if (nowHeldError) return errorResponse(500, "query_failed", requestId);
      const nowHeldKeys = new Set(
        (nowHeld ?? [])
          .map((row) => (row as { passport_pubkey?: unknown }).passport_pubkey)
          .filter((key): key is string => typeof key === "string")
      );
      plan = plan.map((item) => {
        if (item.action !== "create" || availability.get(item.passportPubkey) !== false) return item;
        return nowHeldKeys.has(item.passportPubkey)
          ? { action: "skip", name: item.name, passportPubkey: item.passportPubkey, reason: "already_exists" }
          : { action: "reject", name: item.name, reason: "passport_registered_elsewhere" };
      });
    }
  }
  const ownershipPlan = ownership == null ? null : planOwnershipImport(ownership, owner != null);

  const report = {
    dry_run: dryRun,
    // `complete` answers whether the full file is now (or, for dry runs, can
    // be) represented. Existing agents are safe skips; any refusal or failed
    // write means the operator has a partial restore, never a success-shaped
    // response with missing agents.
    complete:
      plan.every((item) => item.action !== "reject") && ownershipPlan?.action !== "reject",
    agents: {
      ...summarizePlan(plan),
      created: [] as string[],
      skipped: plan.filter((p) => p.action === "skip").map((p) => p.name),
      rejected: plan
        .filter((p): p is Extract<typeof p, { action: "reject" }> => p.action === "reject")
        .map((p) => ({ name: p.name, reason: p.reason })),
    },
    ownership: ownershipPlan?.action ?? "absent",
    // Restated in the response, not only in the export file, because this is
    // what a restore script sees. Nothing below is imported by any code path.
    not_restored: [
      "Provider API keys — re-enter one per provider.",
      "Control API keys and Direct Agent Keys — reissue them.",
      "MFA enrolment, recovery codes and sessions.",
      "Break-glass grants, which are time-boxed elevations rather than configuration.",
    ],
  };

  if (dryRun) return jsonResponse({ data: report }, requestId);

  const recount = () => {
    // Counts come from what happened, not from the original plan. The latter
    // is only a preview; a concurrent registration can legitimately change the
    // final result.
    report.agents.create = report.agents.created.length;
    report.agents.skip = report.agents.skipped.length;
    report.agents.reject = report.agents.rejected.length;
    report.complete = report.complete && report.agents.rejected.length === 0;
  };

  const audit = async (failure?: string) => {
    await recordAdminAction({
      userId,
      action: "workspace.import",
      targetType: "workspace",
      targetId: userId,
      metadata: {
        via: "api",
        key_id: keyId,
        created: report.agents.created.length,
        skipped: report.agents.skipped.length,
        rejected: report.agents.rejected.length,
        complete: report.complete,
        ...(failure ? { failure } : {}),
      },
    });
  };

  // Row at a time rather than one batch insert: a batch fails whole, so a
  // single refused row would discard every good one, and the unique-violation
  // path below could not tell which passport caused it.
  for (const item of plan) {
    if (item.action !== "create") continue;
    // user_id comes from the authenticated caller, never from the file.
    const { error } = await db.from("agents").insert({ ...item.row, user_id: userId });
    if (!error) {
      report.agents.created.push(item.name);
      continue;
    }
    if (!passportKeyConflict(error)) {
      // This is an honest partial contract: previously inserted agents remain
      // named in both the response and the audit record, and later independent
      // rows are still attempted. Returning a bare 500 here used to erase the
      // only report of an earlier successful write.
      report.agents.rejected.push({ name: item.name, reason: "write_failed" });
      report.complete = false;
      continue;
    }

    // The global passport namespace collision has two very different meanings
    // and they must not be reported alike:
    //
    //   the caller now holds it   a create raced this import. Skipped: the
    //                             workspace really does have the agent.
    //   someone else holds it     nothing was written and the agent is ABSENT.
    //                             Calling that "skipped (already exists)" would
    //                             tell an operator their fleet was restored
    //                             when it is empty — the exact false
    //                             reassurance this feature exists to remove.
    //
    // Only the failure path pays for the extra read.
    const { data: mine, error: rereadError } = await db
      .from("agents")
      .select("id")
      .eq("user_id", userId)
      .eq("passport_pubkey", item.passportPubkey)
      .maybeSingle();
    if (rereadError) {
      // Do not convert an unavailable tenant-scoped check into "registered
      // elsewhere". That assertion is cross-tenant information and is safe
      // only once the re-read conclusively says the caller does not hold it.
      report.agents.rejected.push({ name: item.name, reason: "write_failed" });
      report.complete = false;
      recount();
      await audit("query_failed");
      return errorResponse(500, "query_failed", requestId);
    }
    if (mine) {
      report.agents.skipped.push(item.name);
    } else {
      // Says that the passport is taken, not who by. The key is public anyway —
      // it is printed on /verify and carried in every receipt — but the
      // operator's actual question is "why is this agent not here", and this
      // answers it.
      report.agents.rejected.push({ name: item.name, reason: "passport_registered_elsewhere" });
    }
  }

  if (ownershipPlan?.action === "create") {
    const { error } = await db.from("agent_owners").insert({ ...ownershipPlan.row, user_id: userId });
    // A failed ownership row must not discard the agents that were created, so
    // it downgrades the report rather than failing the request.
    if (error) {
      report.ownership = "reject";
      report.complete = false;
    }
  }

  recount();
  await audit();

  return jsonResponse({ data: report }, requestId);
});

export function POST(req: Request): Promise<Response> {
  return handler(req);
}
