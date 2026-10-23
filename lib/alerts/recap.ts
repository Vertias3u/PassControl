import type { SupabaseClient } from "@supabase/supabase-js";
import { readWeeklyRecap, weeklyRecapPeriod } from "@/lib/recap";
import { redis } from "@/lib/state/redis";
import { redactSecrets } from "@/lib/redact";
import { parseAlertDestination } from "@/lib/alerts/destination";
import { postWorkspaceAlert } from "@/lib/alerts/workspace";

const WEEK_MS = 7 * 86_400_000;
const PAGE_SIZE = 500;
// Below Discord's 2000-character limit; also fits Telegram and Slack. Slice
// after redaction, so a secret split across parts cannot escape the scrubber.
const PART_LENGTH = 1900;

export interface RecapRunResult {
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * Runs after the existing daily statements. Normally delivers on Monday; an
 * unavailable read can catch up later that week. No new schedule or schema.
 *
 * One saved destination per workspace (0078). Recaps use that destination;
 * the existing refused/budget/security switches describe those event alerts,
 * not this weekly summary. No deployment/operator webhook is consulted.
 */
export async function runWeeklyRecaps(db: SupabaseClient, at = new Date()): Promise<RecapRunResult> {
  const result: RecapRunResult = { sent: 0, skipped: 0, failed: 0 };
  const period = weeklyRecapPeriod(at);
  const weekEnd = Date.parse(period.end) + WEEK_MS;
  try {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      // Cron discovery ONLY: enumerate configured workspace IDs, never their
      // settings or secrets. Every subsequent table/RPC/data read is scoped by
      // hand, because the service client bypasses RLS.
      const { data, error } = await db.from("workspace_alerts").select("user_id")
        .order("user_id").range(offset, offset + PAGE_SIZE - 1);
      if (error || !Array.isArray(data)) throw new Error("Recap discovery unavailable");
      for (const row of data as { user_id: string }[]) {
        try {
          const userId = row.user_id;
          if (typeof userId !== "string" || !userId) throw new Error("Missing workspace");
          const key = `weekly_recap:${userId}:${period.end}`;
          // Already sent: avoid C6's database/RPC work on the other six days.
          if (await redis().get(key)) { result.skipped++; continue; }
          const { data: settings, error: settingsError } = await db.from("workspace_alerts")
            .select("destination").eq("user_id", userId).maybeSingle();
          if (settingsError) throw new Error("Recap settings unavailable");
          if (!settings) { result.skipped++; continue; }
          const { data: url, error: urlError } = await db.rpc("get_workspace_alert_url_for_user", { p_user_id: userId });
          if (urlError) throw new Error("Recap destination unavailable");
          const destination = typeof url === "string" ? parseAlertDestination(url) : null;
          if (!destination || destination.kind !== settings.destination) { result.skipped++; continue; }

          // C6 scopes every fleet/log page and uses ONLY owned IDs for its
          // legacy spend RPC. An unreadable week never becomes a zero week.
          const recap = await readWeeklyRecap(userId, at);
          if (recap.state === "unavailable") throw new Error("Recap unavailable");
          const text = redactSecrets(recap.text);
          // Do not let a slow old-week read send after the UTC week changes.
          const ttl = Math.ceil((weekEnd - Date.now()) / 1000);
          if (ttl <= 0) { result.skipped++; continue; }
          if (await redis().set(key, "1", { nx: true, ex: ttl }) === null) { result.skipped++; continue; }
          // Keep the claim after ANY send attempt: a timeout can mean delivery
          // succeeded but its reply was lost. Retrying risks a duplicate recap.
          for (let start = 0; start < text.length; start += PART_LENGTH) {
            if (!(await postWorkspaceAlert(destination.url, {
              type: "recap", recapText: text.slice(start, start + PART_LENGTH),
              agentName: "", at, dashboardUrl: "",
            }))) throw new Error("Recap delivery failed");
          }
          result.sent++;
        } catch {
          // Never log database/provider errors, URLs, credentials or recap text.
          // Count this workspace and continue; statements have already run.
          result.failed++;
        }
      }
      if (data.length < PAGE_SIZE) break;
    }
  } catch {
    // Discovery/client failures must not reject the cron's statement work.
    result.failed++;
  }
  return result;
}
