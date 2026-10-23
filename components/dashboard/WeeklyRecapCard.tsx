import Link from "next/link";
import { SectionHeader } from "@/components/dashboard/SectionHeader";
import { formatRecapMoney, readWeeklyRecap, type WeeklyRecap } from "@/lib/recap";

/** Server component: no service client or workspace data enters a client bundle. */
export function WeeklyRecapCard({ userId, at }: { userId: string; at?: Date }) {
  // Return the promise directly: React 18 dev stack tracing probes functions
  // without props, and a synchronous prop error must not become a rejected promise.
  return readWeeklyRecap(userId, at).then((recap) => <WeeklyRecapContent recap={recap} />);
}

export function WeeklyRecapContent({ recap }: { recap: WeeklyRecap }) {
  return (
    <section id="weekly-recap" className="pc-section scroll-mt-28" aria-label="Weekly spend recap" data-state={recap.state}>
      <SectionHeader
        eyebrow="Last completed week"
        title="Weekly spend recap"
        description={
          <span>
            <time dateTime={recap.period.start}>{recap.period.start.slice(0, 10)}</time>
            {" to "}<time dateTime={recap.period.end}>{recap.period.end.slice(0, 10)}</time>
            {" · Monday 00:00 to Monday 00:00 UTC"}
          </span>
        }
      />
      <div className="pc-section__body">
        {recap.state === "unavailable" ? (
          <p className="text-sm text-[var(--pc-quiet)]">Could not read the weekly recap. Try again later.</p>
        ) : recap.state === "empty" ? (
          <p className="text-sm text-[var(--pc-quiet)]">{recap.text}</p>
        ) : (
          <>
            <dl className="grid gap-4 text-sm sm:grid-cols-3">
              <div><dt className="text-xs text-[var(--pc-quiet)]">Week spend</dt><dd className="mt-1 text-xl tabular-nums text-[var(--pc-paper)]">{formatRecapMoney(recap.totals.spentMicrocents)}</dd></div>
              <div><dt className="text-xs text-[var(--pc-quiet)]">Previous week</dt><dd className="mt-1 text-xl tabular-nums text-[var(--pc-paper)]">{formatRecapMoney(recap.totals.previousSpentMicrocents)}</dd></div>
              <div><dt className="text-xs text-[var(--pc-quiet)]">Policy stops</dt><dd className="mt-1 text-[var(--pc-calm)]">{recap.totals.refusedCalls} refused · {recap.totals.pausedCalls} paused</dd></div>
            </dl>
            <ol className="mt-5 divide-y divide-[var(--pc-line-subtle)]" aria-label="Agents by weekly spend">
              {recap.agents.map((agent) => (
                <li key={agent.id} className="grid min-w-0 gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="min-w-0">
                    <Link href={`/dashboard/agents/${encodeURIComponent(agent.id)}`} className="break-words text-sm font-semibold text-[var(--pc-paper)]">{agent.name}</Link>
                    <p className="mt-1 break-words text-xs leading-relaxed text-[var(--pc-quiet)]">
                      Top models by calls: {agent.topModels.length ? agent.topModels.map((model) => `${model.provider}/${model.model} (${model.calls})`).join(", ") : "None recorded"}
                    </p>
                    <p className="mt-1 text-xs text-[var(--pc-calm)]">{agent.refusedCalls} refused · {agent.pausedCalls} paused</p>
                  </div>
                  <p className="text-sm tabular-nums text-[var(--pc-paper)]">
                    {formatRecapMoney(agent.spentMicrocents)}
                    <span className="mt-1 block text-xs text-[var(--pc-quiet)]">previous {formatRecapMoney(agent.previousSpentMicrocents)}</span>
                  </p>
                </li>
              ))}
            </ol>
            {recap.moreAgents > 0 ? <p className="mt-3 text-xs text-[var(--pc-quiet)]">and {recap.moreAgents} more · totals include all agents</p> : null}
          </>
        )}
      </div>
    </section>
  );
}
