"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Search } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";

const COMMANDS = [
  { label: "Overview", hint: "Fleet health and live controls", href: "/dashboard#overview" },
  { label: "Fleet", hint: "Find and operate agent passports", href: "/dashboard#fleet" },
  { label: "Activity", hint: "Governed calls and operator actions", href: "/dashboard#activity" },
  { label: "Spend", hint: "Loaded usage and token volume", href: "/dashboard#spend" },
  { label: "Settings", hint: "Credentials, MFA, and ownership", href: "/dashboard/settings" },
  { label: "Verify passport", hint: "Open the public verification tool", href: "/verify" },
] as const;

export interface CommandPaletteAgent {
  id: string;
  name: string;
  passport_pubkey: string | null;
}

const AGENT_TARGETS = [
  { label: "Identity", hash: "agent-identity", hint: "passport and key lifecycle" },
  { label: "Policy", hash: "agent-policy", hint: "live rules and policy lab" },
  { label: "Activity", hash: "agent-activity", hint: "stored call history" },
] as const;

export function agentCommandsForQuery(agents: readonly CommandPaletteAgent[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return agents
    .filter((agent) => {
      const identity = agent.passport_pubkey ?? "direct agent key";
      const suffix = agent.passport_pubkey?.slice(-16).toLowerCase() ?? "";
      return `${agent.name} ${identity} ${suffix}`.toLowerCase().includes(needle);
    })
    .slice(0, 8)
    .flatMap((agent) =>
      AGENT_TARGETS.map((target) => ({
        label: `${agent.name} · ${target.label}`,
        hint: agent.passport_pubkey
          ? `${target.hint} · passport …${agent.passport_pubkey.slice(-12)}`
          : `${target.hint} · direct agent identity`,
        href: `/dashboard/agents/${agent.id}#${target.hash}`,
      }))
    );
}

export function DashboardCommandPalette({ agents = [] }: { agents?: CommandPaletteAgent[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const { destinations, agentMatches } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const destinations = needle
      ? COMMANDS.filter((command) => `${command.label} ${command.hint}`.toLowerCase().includes(needle))
      : COMMANDS;
    return {
      destinations,
      agentMatches: agentCommandsForQuery(agents, query),
    };
  }, [agents, query]);

  return (
    <>
      <button type="button" className="pc-command-trigger" aria-label="Navigate the Control Tower" onClick={() => setOpen(true)}>
        <Search aria-hidden="true" />
        <span>Navigate</span>
        <kbd>⌘/Ctrl K</kbd>
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
        title="Navigate the Control Tower"
        description="Search safe destinations. Consequential actions stay in their full review surfaces."
        className="pc-command-dialog"
      >
        <div className="pc-command-palette">
          <label className="pc-command-search">
            <Search aria-hidden="true" />
            <span className="sr-only">Search destinations</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search destinations…"
              autoComplete="off"
            />
          </label>
          <nav className="pc-command-list" aria-label="Control Tower destinations">
            {destinations.length ? <p className="pc-command-group">Destinations</p> : null}
            {destinations.map((command) => (
              <Link key={command.href} href={command.href} onClick={() => setOpen(false)}>
                <span><strong>{command.label}</strong><small>{command.hint}</small></span>
                <ArrowRight aria-hidden="true" />
              </Link>
            ))}
            {agentMatches.length ? <p className="pc-command-group">Agents</p> : null}
            {agentMatches.map((command) => (
              <Link key={command.href} href={command.href} onClick={() => setOpen(false)}>
                <span><strong>{command.label}</strong><small>{command.hint}</small></span>
                <ArrowRight aria-hidden="true" />
              </Link>
            ))}
            {!query.trim() && agents.length ? (
              <p className="pc-command-agent-hint">Search {agents.length} agent{agents.length === 1 ? "" : "s"} by name or passport public-key suffix.</p>
            ) : null}
            {destinations.length === 0 && agentMatches.length === 0 ? <p>No matching destination or agent.</p> : null}
          </nav>
        </div>
      </Dialog>
    </>
  );
}
