import { serviceClient } from "@/lib/supabase";
import { listDelegations, type DelegationListing } from "@/lib/delegation/manage";

/**
 * The delegations this owner's agent's workers have used (Bet D). Service-role read,
 * so `userId` (from the signed-in session, never the browser) is the tenant boundary;
 * listDelegations filters on it. `null` means the read failed, typically a database
 * that predates 0081, and the panel says so rather than claiming there are none.
 */
export async function readAgentDelegations(userId: string, agentId: string): Promise<DelegationListing[] | null> {
  try {
    const r = await listDelegations(serviceClient(), userId, agentId);
    return r.ok ? r.delegations : null;
  } catch {
    return null;
  }
}
