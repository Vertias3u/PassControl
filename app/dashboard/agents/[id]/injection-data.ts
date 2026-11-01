import { INJECTION_FINDINGS_TABLE } from "@/lib/injection-findings";
import type { InjectionFindingRow, InjectionFindingsRead } from "@/components/InjectionFindingsPanel";
import type { InjectionTaintView } from "@/components/InjectionTaintControl";
import { readTaint } from "@/lib/state/taint";

const SHOWN = 50;
// Not `content_hmac`: it identifies a block to the gateway's de-duplication and means
// nothing to a reader.
const COLUMNS_0089 = "id, created_at, source, path, families, severity, detector, provider, model";
// 0090 adds the sidecar's rows and the tool that returned the block; 0091, the gap.
const COLUMNS_0090 = `${COLUMNS_0089}, surface, tool_name`;
const COLUMNS_BY_AGE = [`${COLUMNS_0090}, gap`, COLUMNS_0090, COLUMNS_0089];
const isMissingColumn = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "42703" || code === "PGRST204";
};

// The query chain this reads, typed only as far as it is used (as in reported-data.ts:
// matching the Supabase client structurally sends the type checker into infinite
// instantiation).
type Query = {
  select: (columns: string) => Query;
  eq: (column: string, value: string) => Query;
  order: (column: string, options: { ascending: boolean }) => Query;
  limit: (n: number) => PromiseLike<{ data: unknown; error: unknown }>;
};

/**
 * This agent's newest injection findings (migration 0089), read with the signed-in
 * user's client, so RLS keeps it to their own rows. Any failed read, typically a
 * database before 0089, is "unavailable": the section never stops the page rendering.
 */
export async function readInjectionFindings(db: { from: (table: string) => unknown }, agentId: string): Promise<InjectionFindingsRead> {
  const read = (columns: string) =>
    (db.from(INJECTION_FINDINGS_TABLE) as Query)
      .select(columns)
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(SHOWN);
  try {
    let age = 0;
    let { data, error } = await read(COLUMNS_BY_AGE[age]!);
    while (error && isMissingColumn(error) && age < COLUMNS_BY_AGE.length - 1) ({ data, error } = await read(COLUMNS_BY_AGE[++age]!));
    if (error || !Array.isArray(data)) return { state: "unavailable" };
    return { state: "ok", rows: data as InjectionFindingRow[] };
  } catch {
    return { state: "unavailable" };
  }
}

/**
 * The hold's state for the agent page, in hold mode only. Server-side, through the
 * same Redis the gateway holds on; the caller has already found the agent through
 * the signed-in user's own session.
 */
export async function readInjectionTaintView(agentId: string, nowMs: number): Promise<InjectionTaintView> {
  try {
    const taint = await readTaint(agentId, nowMs);
    if (!taint) return { state: "clear" };
    const until = new Date(taint.until).toISOString();
    return taint.families.length === 0 ? { state: "tainted", until, unchecked: true } : { state: "tainted", until };
  } catch {
    return { state: "unknown" };
  }
}
