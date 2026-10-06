import Link from "next/link";
import { redirect } from "next/navigation";

import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { ServiceLogo } from "@/components/ServiceLogo";
import { ServiceStopControl } from "@/components/ServiceStopControl";
import { needsMfaStepUp } from "@/lib/mfa";
import { SERVICE_CATALOG } from "@/lib/services/catalog";
import { defaultHourlyCapFor } from "@/lib/services/rules";
import { SERVICE_DISPLAY } from "@/lib/services/display";
import { isServiceId } from "@/lib/services/catalog";
import { observeServiceKill } from "@/lib/state/killswitch";
import { userClient } from "@/lib/supabase/server";
import { readServicesOverview, type ServiceOverview } from "./services-data";

export const dynamic = "force-dynamic";
export const metadata = { title: "Services" };

// Services (any-API phase 2): the APIs other than model providers that agents
// reach through PassControl. Per service: the stop switch, the token in use,
// which agents have access, and the last hour. Tokens are added and rotated
// under Settings; this page is where an operator looks during an incident.
export default async function ServicesPage() {
  const db = await userClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");
  if (await needsMfaStepUp(db)) redirect("/login/verify");

  const services = await readServicesOverview(db, user.id, { observeKill: observeServiceKill });
  const failClosed = process.env.KILL_SWITCH_FAIL_CLOSED === "true";

  return (
    <DashboardShell
      userId={user.id}
      active="services"
      eyebrow="Credential vault"
      title="Services"
      description="APIs other than model providers that your agents reach through PassControl. The token stays in Vault, each agent has its own rules, and you can stop one service for every agent without touching their model calls."
    >
      {services.map((service) => (
        <ServiceCard key={service.id} service={service} failClosed={failClosed} />
      ))}
    </DashboardShell>
  );
}

function ServiceCard({ service, failClosed }: { service: ServiceOverview; failClosed: boolean }) {
  const { token, agents, lastHour } = service;
  return (
    <section className="pc-section" data-service-card={service.id} aria-labelledby={`service-${service.id}`}>
      <div className="pc-section__body grid gap-5">
        <h2 id={`service-${service.id}`} className="flex items-center gap-2 text-lg font-semibold">
          <ServiceLogo service={service.id} />
          {service.label}
        </h2>

        <ServiceStopControl
          service={service.id}
          serviceLabel={service.label}
          initialStopped={service.stopped}
          failClosed={failClosed}
        />

        <div className="grid gap-1" data-service-token={token.state}>
          <h3 className="text-sm font-semibold">Token</h3>
          {token.state === "stored" ? (
            <p className="text-sm text-muted-foreground">
              In use: <strong>{token.label?.trim() || "Unnamed"}</strong>, added {token.createdAt.slice(0, 10)}
              {token.count > 1 ? ` (${token.count} stored)` : ""}.{" "}
              <Link href="/dashboard/settings#services">Manage in Settings</Link>
            </p>
          ) : token.state === "none" ? (
            <p className="pc-inline-notice" role="status">
              No {service.label} token is stored, so every {service.label} call is refused.{" "}
              <Link href="/dashboard/settings#services">Add one in Settings</Link>.
            </p>
          ) : (
            <p className="pc-inline-notice is-danger" role="alert">
              The stored {service.label} token could not be read. This says nothing about whether one is stored.
            </p>
          )}
        </div>

        <div className="grid gap-2" data-service-agents={agents.state}>
          <h3 className="text-sm font-semibold">Agents with access</h3>
          {agents.state === "unavailable" ? (
            <p className="pc-inline-notice is-danger" role="alert">
              Which agents can reach {service.label} could not be read.
            </p>
          ) : agents.withAccess.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-service-agents-count="0">
              None of your {agents.total} agents can call {service.label}. Access is deny by default; give an agent
              rules on its own page, under {service.label} access.
            </p>
          ) : (
            <ul className="pc-credential-list" aria-label={`Agents with ${service.label} access`}>
              {agents.withAccess.map((agent) => (
                <li key={agent.id} className="pc-credential" data-service-agent={agent.id} data-access={agent.state}>
                  <Link href={`/dashboard/agents/${agent.id}#${isServiceId(service.id) ? SERVICE_DISPLAY[service.id].sectionId : "agent-services"}`}>{agent.name}</Link>
                  {agent.state === "malformed" ? (
                    <span className="pc-inline-notice is-danger">Rules not valid: every {service.label} call is refused</span>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {agent.rules} {agent.rules === 1 ? "rule" : "rules"}
                      {agent.writes > 0 ? `, ${agent.writes} ${agent.writes === 1 ? "write" : "writes"}` : ", read-only"} ·{" "}
                      {agent.cap ?? defaultHourlyCapFor(service.id)} calls/hour
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="grid gap-1" data-service-last-hour={lastHour.state}>
          <h3 className="text-sm font-semibold">Last hour</h3>
          {lastHour.state === "ok" ? (
            <p className="text-sm text-muted-foreground">
              {lastHour.calls} {lastHour.calls === 1 ? "call" : "calls"}, {lastHour.refused} refused by PassControl.{" "}
              <Link href="/dashboard#activity">See activity</Link>
            </p>
          ) : (
            <p className="pc-inline-notice is-danger" role="alert">
              The last hour&apos;s {service.label} calls could not be counted.
            </p>
          )}
        </div>

        <p className="text-xs text-muted-foreground" data-service-never>
          {SERVICE_CATALOG[service.id].neverSummary}
        </p>
      </div>
    </section>
  );
}
