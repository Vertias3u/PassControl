// Listing one agent on the operator's public /@handle page.
//
// This is a DISCLOSURE act, not a setting, and the two rules that follow from
// that are enforced here rather than at the call site:
//
// 1. A LABEL IS REQUIRED. `agents.name` is customer-identifying — 0015 refuses
//    it on the public passport surface because `acme-prod-billing` published
//    under a vendor's handle is a customer list, and the same reasoning applies
//    to a profile page. 0033 makes the state unrepresentable
//    (`agents_published_needs_label`), so publishing without one is a 23514
//    that nothing maps; this refuses it first, with a message.
//
//    In particular there is no `coalesce(public_label, name)` anywhere in this
//    file or in the RPC. That "fix" for a blank row is precisely the leak.
//
// 2. THE SECOND OPT-IN IS NOT IMPLIED. Publishing an agent does not make the
//    profile public and does not check that it is. An operator can stage which
//    agents they intend to list before the page exists — the RPC requires BOTH
//    flags, so nothing is visible until they also publish the profile. The UI
//    is required to say which of the two is still missing.
//
// Server-write only: 0011 replaced the table-wide grant on public.agents with a
// column allowlist, and 0033 deliberately did not add these two columns to it,
// so the client cannot write them at all. The tenant boundary is therefore in
// code — `userId` comes from a verified session and is filtered on explicitly.
import type { SupabaseClient } from "@supabase/supabase-js";

type PublishDatabase = Pick<SupabaseClient, "from">;

/** Matches 0033's `agents_public_label_len`. */
export const PUBLIC_LABEL_MAX_LENGTH = 60;

export interface PublishedAgentRecord {
  id: string;
  name: string;
  published: boolean;
  public_label: string | null;
}

export type PublishResult =
  | { ok: true; data: PublishedAgentRecord }
  | { ok: false; status: number; code: string };

const COLUMNS = "id, name, published, public_label";

/**
 * Publish or unpublish one agent, and set the label it is published under.
 *
 * Unpublishing KEEPS the label. It is the operator's wording, they may well
 * re-publish, and clearing it would silently discard something they wrote —
 * while leaving it costs nothing, since the RPC filters on `published` anyway.
 */
export async function setAgentPublished(
  db: PublishDatabase,
  userId: string,
  agentId: string,
  input: { published: boolean; label?: unknown }
): Promise<PublishResult> {
  const label = typeof input.label === "string" ? input.label.trim() : "";

  if (input.published) {
    if (!label) return { ok: false, status: 400, code: "label_required" };
    if (label.length > PUBLIC_LABEL_MAX_LENGTH) {
      return { ok: false, status: 400, code: "label_too_long" };
    }
    // A label identical to the internal name is NOT refused here. The operator
    // owns that name and `research-bot` is a perfectly reasonable thing to
    // publish; refusing would be paternalistic and would block a legitimate
    // case. The UI warns when the two match, which is the right place for a
    // judgement that depends on what the name actually contains.
  }

  const patch: Record<string, unknown> = { published: input.published };
  if (label) patch.public_label = label.slice(0, PUBLIC_LABEL_MAX_LENGTH);

  const { data, error } = await db
    .from("agents")
    .update(patch)
    .eq("id", agentId)
    .eq("user_id", userId) // tenant boundary — service_role bypasses RLS
    .select(COLUMNS)
    .maybeSingle();

  if (error) {
    // The check constraint is the backstop for a caller that skipped the guard
    // above. Reported as the same thing the guard reports, not as a raw code.
    if (typeof (error as { code?: unknown }).code === "string" && (error as { code: string }).code === "23514") {
      return { ok: false, status: 400, code: "label_required" };
    }
    return { ok: false, status: 500, code: "write_failed" };
  }
  // No error and no row: the agent is not this tenant's, or does not exist.
  // One answer for both, so this is not a probe for which agent ids exist.
  if (!data) return { ok: false, status: 404, code: "no_agent" };

  return { ok: true, data: data as PublishedAgentRecord };
}
