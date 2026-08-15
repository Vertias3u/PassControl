"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Eye,
  EyeOff,
  Expand,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Radio,
  RotateCcw,
  WifiOff,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { browserClient } from "@/lib/supabase/client";
import type { DepartureRow } from "@/lib/departures";
import {
  appendPresentationEventQueue,
  eventFromStoredRow,
  mergeRealtimeStoredEvent,
  presentationOutcomeForStatus,
  presentationSnapshot,
  type ControlGraphEdge,
  type ControlGraphEvent,
  type ControlGraphNode,
  type ControlGraphSnapshot,
  type PresentationIdentityMode,
} from "@/lib/control-graph";
import { CallDetailDrawer, type CallContext } from "@/components/dashboard/CallDetailDrawer";
import { DashboardTimestamp } from "@/components/dashboard/DashboardTime";
import { VertiasLogo, VertiasWordmark } from "@/components/VertiasLogo";

const WIDTH = 960;
const HEIGHT = 620;
const MAX_EVENTS = 40;
const MAX_ANIMATION_QUEUE = 12;
const MIN_ZOOM = 0.55;
const MAX_ZOOM = 2.2;

export interface ControlGraphView {
  x: number;
  y: number;
  k: number;
}

export function zoomViewAtPoint(
  current: ControlGraphView,
  anchor: { x: number; y: number },
  requestedScale: number
): ControlGraphView {
  const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, requestedScale));
  const worldX = (anchor.x - current.x) / current.k;
  const worldY = (anchor.y - current.y) / current.k;
  return {
    x: anchor.x - worldX * k,
    y: anchor.y - worldY * k,
    k,
  };
}

type ForceNode = ControlGraphNode & SimulationNodeDatum;
type ForceLink = SimulationLinkDatum<ForceNode> & ControlGraphEdge;

function xTarget(node: ForceNode) {
  if (node.kind === "agent") return 155;
  if (node.kind === "gate") return 470;
  if (node.kind === "credential") return 620;
  return 820;
}

function nodeRadius(node: ControlGraphNode) {
  if (node.kind === "gate") return 46;
  if (node.kind === "credential") return 31;
  if (node.kind === "provider") return 36;
  return 31;
}

function visibleNodeLabel(label: string) {
  return label.length > 22 ? `${label.slice(0, 19)}…` : label;
}

function shortStatus(event: ControlGraphEvent) {
  return event.label.replace("Blocked by ", "").replace(" stored", "");
}

function remainingBrief(expiresAt: string, now: number) {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes ? `${minutes}m ` : ""}${seconds % 60}s`;
}

function isBaseEdge(edge: ControlGraphEdge) {
  return edge.kind === "identity" || edge.kind === "approval" || edge.kind === "dispatch";
}

function routeDescription(edge: ControlGraphEdge, sourceLabel: string, targetLabel: string) {
  if (edge.kind === "identity") return `${sourceLabel} is governed by PassControl.`;
  if (edge.kind === "approval") return "A call reaches the server-side key only after PassControl allows it.";
  if (edge.kind === "dispatch") return `An allowed call can be dispatched to ${targetLabel}.`;
  if (edge.kind === "scope") return `${sourceLabel} may reach ${targetLabel} for ${edge.models?.join(", ") || "its configured models"}.`;
  if (edge.kind === "elevation") return `${sourceLabel} has temporary break-glass access to ${targetLabel}.`;
  return `${sourceLabel} may fall back to ${targetLabel} at position ${edge.order ?? 1}.`;
}

function routePath(points: Array<{ x?: number; y?: number }>) {
  return points.map((point, index) => `${index ? "L" : "M"}${point.x ?? 0},${point.y ?? 0}`).join(" ");
}

function routeLabel(edge: ControlGraphEdge) {
  const models = edge.models?.join(", ") || "configured models";
  if (edge.kind === "scope") return models;
  if (edge.kind === "fallback") return `fallback ${edge.order ?? 1} · ${models}`;
  return "";
}

export function ControlGraph({
  userId,
  initialSnapshot,
  callContext,
}: {
  userId: string;
  initialSnapshot: ControlGraphSnapshot;
  callContext: CallContext;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const simulationRef = useRef<ReturnType<typeof forceSimulation<ForceNode>> | null>(null);
  const nodesRef = useRef<ForceNode[]>([]);
  const queuedRef = useRef<ControlGraphEvent[]>([]);
  const animationQueueRef = useRef<ControlGraphEvent[]>([]);
  const liveEventIdsRef = useRef(new Set<string>());
  const pausedRef = useRef(false);
  const seenRef = useRef(new Set(initialSnapshot.events.map((event) => event.id)));
  const dragRef = useRef<string | null>(null);
  const panRef = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [tick, setTick] = useState(0);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    initialSnapshot.nodes.find((node) => node.kind === "agent")?.id ?? null
  );
  const [selectedRow, setSelectedRow] = useState<DepartureRow | null>(null);
  const [activeEvent, setActiveEvent] = useState<ControlGraphEvent | null>(null);
  const [live, setLive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [queued, setQueued] = useState(0);
  const [presentation, setPresentation] = useState(false);
  const [presentationIdentity, setPresentationIdentity] = useState<PresentationIdentityMode>("anonymous");
  const [reducedMotion, setReducedMotion] = useState(false);
  const [clock, setClock] = useState(0);
  const [view, setView] = useState<ControlGraphView>({ x: 0, y: 0, k: 1 });

  const shown = useMemo(
    () => (presentation ? presentationSnapshot(snapshot, presentationIdentity) : snapshot),
    [presentation, presentationIdentity, snapshot]
  );

  const selectedNode = selectedNodeId ? shown.nodes.find((node) => node.id === selectedNodeId) ?? null : null;
  const activeEventIndex = activeEvent
    ? snapshot.events.findIndex((event) => event.id === activeEvent.id)
    : -1;
  const shownActiveEvent = presentation && activeEventIndex >= 0
    ? shown.events[activeEventIndex] ?? null
    : activeEvent;
  const focusedAgentNodeId = presentation
    ? shownActiveEvent?.agentNodeId ?? shown.nodes.find((node) => node.kind === "agent")?.id ?? null
    : null;
  const visibleEdges = useMemo(() => shown.edges.filter((edge) => {
    if (isBaseEdge(edge) || edge.kind === "elevation") return true;
    if (focusedAgentNodeId) return edge.agentId === shown.nodes.find((node) => node.id === focusedAgentNodeId)?.agentId;
    if (selectedNode?.kind === "agent") return edge.agentId === selectedNode.agentId;
    if (selectedNode?.kind === "provider") return edge.provider === selectedNode.provider && edge.kind === "scope";
    return false;
  }), [focusedAgentNodeId, selectedNode, shown.edges, shown.nodes]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!shown.edges.some((edge) => edge.kind === "elevation" && edge.expiresAt)) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [shown.edges]);

  useEffect(() => {
    const nodes: ForceNode[] = shown.nodes.map((node, index) => {
      const old = nodesRef.current.find((candidate) => candidate.id === node.id);
      return {
        ...node,
        x: old?.x ?? xTarget(node as ForceNode),
        y: old?.y ?? 95 + ((index * 83) % (HEIGHT - 190)),
        fx: old?.fx,
        fy: old?.fy,
      };
    });
    const byId = new Set(nodes.map((node) => node.id));
    const links: ForceLink[] = visibleEdges
      .filter(isBaseEdge)
      .filter((edge) => byId.has(edge.source) && byId.has(edge.target))
      .map((edge) => ({ ...edge }));
    const lane = new Map<string, number>();
    for (const kind of ["agent", "provider"] as const) {
      const group = nodes.filter((node) => node.kind === kind);
      group.forEach((node, index) => {
        lane.set(node.id, group.length === 1 ? HEIGHT / 2 : 90 + index * ((HEIGHT - 180) / (group.length - 1)));
      });
    }
    nodesRef.current = nodes;
    simulationRef.current?.stop();

    const simulation = forceSimulation(nodes)
      .force("charge", forceManyBody<ForceNode>().strength((node) => node.kind === "gate" ? -520 : -250))
      .force("collide", forceCollide<ForceNode>().radius((node) => nodeRadius(node) + 30).iterations(2))
      .force("link", forceLink<ForceNode, ForceLink>(links).id((node) => node.id).distance((link) => link.kind === "identity" ? 235 : 180).strength(0.1))
      .force("x", forceX<ForceNode>((node) => xTarget(node)).strength(0.24))
      .force("y", forceY<ForceNode>((node) => lane.get(node.id) ?? HEIGHT / 2).strength((node) => node.kind === "gate" || node.kind === "credential" ? 0.3 : 0.15))
      .alphaDecay(reducedMotion ? 1 : 0.045)
      .velocityDecay(0.48)
      .on("tick", () => setTick((value) => value + 1));
    simulationRef.current = simulation;
    if (reducedMotion) {
      simulation.tick(1);
      simulation.stop();
      setTick((value) => value + 1);
    }
    return () => {
      simulation.stop();
    };
  }, [reducedMotion, shown.nodes, visibleEdges]);

  useEffect(() => {
    const supabase = browserClient();
    const channel = supabase
      .channel("agent_logs_control_graph")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "agent_logs", filter: `user_id=eq.${userId}` },
        (payload) => {
          const row = payload.new as DepartureRow;
          if (!row?.id || seenRef.current.has(row.id)) return;
          seenRef.current.add(row.id);
          const event = eventFromStoredRow(row);
          liveEventIdsRef.current.add(row.id);
          if (liveEventIdsRef.current.size > MAX_EVENTS) {
            const oldest = liveEventIdsRef.current.values().next().value;
            if (oldest) liveEventIdsRef.current.delete(oldest);
          }
          setSnapshot((current) => mergeRealtimeStoredEvent(current, row, MAX_EVENTS));
          if (pausedRef.current) {
            queuedRef.current = appendPresentationEventQueue(queuedRef.current, event, MAX_EVENTS);
            setQueued(queuedRef.current.length);
          } else {
            setActiveEvent((current) => {
              if (!current) return event;
              animationQueueRef.current = appendPresentationEventQueue(animationQueueRef.current, event, MAX_ANIMATION_QUEUE);
              return current;
            });
          }
        }
      )
      .subscribe((status) => setLive(status === "SUBSCRIBED"));
    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  useEffect(() => {
    if (!activeEvent) return;
    const timer = window.setTimeout(() => {
      const next = animationQueueRef.current.shift() ?? null;
      setActiveEvent(next);
    }, presentation ? 2300 : 1700);
    return () => window.clearTimeout(timer);
  }, [activeEvent, presentation]);

  useEffect(() => {
    const onFullscreen = () => {
      if (document.fullscreenElement !== rootRef.current && presentation) setPresentation(false);
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, [presentation]);

  useEffect(() => {
    if (!presentation) return;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key === "Escape" || event.key === "Esc") && !document.fullscreenElement) setPresentation(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = priorOverflow;
    };
  }, [presentation]);

  const nodeMap = useMemo(() => new Map(nodesRef.current.map((node) => [node.id, node])), [shown.nodes, tick]);
  const selectedAgent = selectedNode?.agentId ? shown.agents[selectedNode.agentId] : null;
  const selectedProviderAgents = selectedNode?.provider
    ? shown.edges
        .filter((edge) => edge.provider === selectedNode.provider && edge.agentId && edge.kind !== "fallback")
        .map((edge) => shown.agents[edge.agentId!]?.name)
        .filter((name): name is string => Boolean(name))
    : [];

  const pathForEvent = (event: ControlGraphEvent) => {
    const start = nodeMap.get(event.agentNodeId) ?? nodeMap.get("agent:historical");
    const gate = nodeMap.get("gate:passcontrol");
    const credential = nodeMap.get("credential:vault");
    const provider = event.providerNodeId ? nodeMap.get(event.providerNodeId) : null;
    if (!start || !gate) return null;
    const points = [start, gate];
    if ((event.stop === "credential" || event.stop === "provider" || event.stop === "receipt") && credential) points.push(credential);
    if ((event.stop === "provider" || event.stop === "receipt") && provider) points.push(provider);
    return routePath(points);
  };

  const eventPath = shownActiveEvent ? pathForEvent(shownActiveEvent) : null;
  const presentationOutcome = shownActiveEvent
    ? presentationOutcomeForStatus(shownActiveEvent.row.status)
    : null;

  const resume = () => {
    const pending = queuedRef.current;
    queuedRef.current = [];
    setQueued(0);
    setPaused(false);
    setActiveEvent((current) => {
      const [first, ...rest] = pending;
      const waiting = current ? pending : rest;
      animationQueueRef.current = [...animationQueueRef.current, ...waiting].slice(-MAX_ANIMATION_QUEUE);
      return current ?? first ?? null;
    });
  };

  const resetLayout = () => {
    nodesRef.current.forEach((node) => {
      node.fx = null;
      node.fy = null;
    });
    setView({ x: 0, y: 0, k: 1 });
    simulationRef.current?.alpha(0.8).restart();
  };

  const togglePresentation = async () => {
    if (document.fullscreenElement === rootRef.current) {
      await document.exitFullscreen();
      return;
    }
    if (presentation) {
      setPresentation(false);
      setPresentationIdentity("anonymous");
      return;
    }
    setPresentationIdentity("anonymous");
    setPresentation(true);
    setSelectedNodeId(null);
    try {
      await rootRef.current?.requestFullscreen();
    } catch {
      setPresentation(true);
    }
  };

  const viewportPoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return null;
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    return point.matrixTransform(matrix.inverse());
  };

  const pointFromPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const point = viewportPoint(event.clientX, event.clientY);
    if (!point) return null;
    return {
      x: (point.x - view.x) / view.k,
      y: (point.y - view.y) / view.k,
    };
  };

  const zoomAtCenter = (delta: number) => {
    setView((current) => zoomViewAtPoint(current, { x: WIDTH / 2, y: HEIGHT / 2 }, current.k + delta));
  };

  const finishPointerInteraction = () => {
    dragRef.current = null;
    panRef.current = null;
    simulationRef.current?.alphaTarget(0);
  };

  return (
    <div
      ref={rootRef}
      className="pc-control-graph"
      data-presentation={presentation}
      data-presentation-identity={presentationIdentity}
      data-live={live}
      data-event-active={shownActiveEvent ? "true" : "false"}
      data-event-tone={presentationOutcome?.tone ?? "idle"}
      data-event-stop={presentationOutcome?.stop ?? "idle"}
      data-kill-armed={shown.killArmed ? "true" : "false"}
      data-emergency-blocked-agents={shown.emergencyBlockedCount}
      onKeyDown={(event) => {
        if (presentation && (event.key === "Escape" || event.key === "Esc") && !document.fullscreenElement) {
          setPresentation(false);
        }
      }}
    >
      <div className="pc-control-graph__stage">
      <div className="pc-control-graph__toolbar">
        {presentation ? (
          <div className="pc-control-graph__brand" aria-label="PassControl presentation">
            <VertiasLogo size={22} />
            <span><VertiasWordmark size={15} /><small>PassControl · Control Graph</small></span>
          </div>
        ) : null}
        <div className="pc-control-graph__status">
          <span className={live ? "is-live" : "is-offline"} role="status">
            {live ? <Radio aria-hidden="true" /> : <WifiOff aria-hidden="true" />}
            {live ? (paused ? `Paused${queued ? ` · ${queued} new` : ""}` : "Live") : "Live feed unavailable"}
          </span>
          <span>{shown.nodes.filter((node) => node.kind === "agent").length} identities</span>
          <span>{shown.nodes.filter((node) => node.kind === "provider").length} providers</span>
          {shown.killArmed ? <span className="is-killed">Kill switch armed</span> : null}
          {shown.emergencyBlockedCount ? <span className="is-killed">{shown.emergencyBlockedCount} agent emergency-blocked</span> : null}
        </div>
        <div className="pc-control-graph__actions">
          <button type="button" onClick={() => (paused ? resume() : setPaused(true))} disabled={!live}>
            {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}{paused ? "Resume" : "Pause"}
          </button>
          {!presentation ? <button type="button" onClick={() => zoomAtCenter(0.18)} aria-label="Zoom in"><ZoomIn aria-hidden="true" /></button> : null}
          {!presentation ? <button type="button" onClick={() => zoomAtCenter(-0.18)} aria-label="Zoom out"><ZoomOut aria-hidden="true" /></button> : null}
          {!presentation ? <button type="button" onClick={resetLayout}><RotateCcw aria-hidden="true" />Reset</button> : null}
          {presentation ? (
            <button
              type="button"
              aria-pressed={presentationIdentity === "named"}
              onClick={() => setPresentationIdentity((current) => current === "anonymous" ? "named" : "anonymous")}
            >
              {presentationIdentity === "anonymous" ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
              {presentationIdentity === "anonymous" ? "Show names" : "Hide names"}
            </button>
          ) : null}
          <button type="button" className="is-primary" onClick={togglePresentation}>
            {presentation ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
            {presentation ? "Exit presentation" : "Presentation mode"}
          </button>
        </div>
      </div>

      <div className="pc-control-graph__legend" aria-label="How to read the graph">
        <strong>Lines are possible routes—not calls.</strong>
        <span><i className="is-base" />Identity and checked dispatch path</span>
        <span><i className="is-scope" />Selected agent&apos;s allowed models</span>
        <span><i className="is-elevation" />Temporary break-glass access</span>
        <span><i className="is-fallback" />Fallback route</span>
        <small>A moving dot appears only when a new stored call arrives.</small>
      </div>

      <div className="pc-control-graph__layout">
        <div className="pc-control-graph__canvas">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="img"
            aria-label="Current agent capability graph and newly recorded governed calls"
            data-view-x={view.x.toFixed(3)}
            data-view-y={view.y.toFixed(3)}
            data-view-scale={view.k.toFixed(3)}
            onWheel={(event) => {
              event.preventDefault();
              const anchor = viewportPoint(event.clientX, event.clientY);
              if (!anchor) return;
              setView((current) => zoomViewAtPoint(
                current,
                anchor,
                current.k * Math.exp(-event.deltaY * 0.0015)
              ));
            }}
            onPointerDown={(event) => {
              if (!event.isPrimary || event.button !== 0) return;
              const point = viewportPoint(event.clientX, event.clientY);
              if (!point) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              panRef.current = { x: point.x, y: point.y, originX: view.x, originY: view.y };
            }}
            onPointerMove={(event) => {
              if (dragRef.current) {
                const node = nodesRef.current.find((candidate) => candidate.id === dragRef.current);
                if (!node) return;
                const point = pointFromPointer(event);
                if (!point) return;
                node.fx = point.x;
                node.fy = point.y;
                simulationRef.current?.alpha(0.28).restart();
                setTick((value) => value + 1);
              } else if (panRef.current) {
                const point = viewportPoint(event.clientX, event.clientY);
                if (!point) return;
                setView((current) => ({
                  ...current,
                  x: panRef.current!.originX + point.x - panRef.current!.x,
                  y: panRef.current!.originY + point.y - panRef.current!.y,
                }));
              }
            }}
            onPointerUp={finishPointerInteraction}
            onPointerCancel={finishPointerInteraction}
            onLostPointerCapture={finishPointerInteraction}
          >
            <defs>
              <filter id="pc-graph-glow"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
              <marker id="pc-graph-arrow-base" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8Z" /></marker>
              <marker id="pc-graph-arrow-scope" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8Z" /></marker>
              <marker id="pc-graph-arrow-elevation" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8Z" /></marker>
              <marker id="pc-graph-arrow-fallback" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8Z" /></marker>
            </defs>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              <g className="pc-control-graph__stages" aria-hidden="true">
                <text x="155" y="105" textAnchor="middle">1 · AGENT ASKS</text>
                <text x="470" y="105" textAnchor="middle">2 · CONTROLS CHECK</text>
                <text x="620" y="105" textAnchor="middle">3 · KEY USED HERE</text>
                <text x="820" y="105" textAnchor="middle">4 · PROVIDER</text>
              </g>
              {visibleEdges.map((edge) => {
                const source = nodeMap.get(typeof edge.source === "string" ? edge.source : String(edge.source));
                const target = nodeMap.get(typeof edge.target === "string" ? edge.target : String(edge.target));
                if (!source || !target) return null;
                const focusedAgentId = focusedAgentNodeId
                  ? shown.nodes.find((node) => node.id === focusedAgentNodeId)?.agentId
                  : selectedNode?.kind === "agent" ? selectedNode.agentId : null;
                const hidden = Boolean(focusedAgentId && edge.agentId && edge.agentId !== focusedAgentId);
                const gate = nodeMap.get("gate:passcontrol");
                const credential = nodeMap.get("credential:vault");
                const permissionPath = !isBaseEdge(edge) && gate && credential
                  ? routePath([source, gate, credential, target])
                  : null;
                const marker = edge.kind === "scope"
                  ? "url(#pc-graph-arrow-scope)"
                  : edge.kind === "elevation"
                    ? "url(#pc-graph-arrow-elevation)"
                    : edge.kind === "fallback"
                      ? "url(#pc-graph-arrow-fallback)"
                      : "url(#pc-graph-arrow-base)";
                const label = routeLabel(edge);
                const description = routeDescription(edge, source.label, target.label);
                return <g key={edge.id} data-muted={hidden}>
                  <title>{description}</title>
                  {permissionPath ? (
                    <path className={`pc-control-graph__edge is-${edge.kind}`} data-muted={hidden} d={permissionPath} markerEnd={marker} />
                  ) : (
                    <line className={`pc-control-graph__edge is-${edge.kind}`} data-muted={hidden} x1={source.x} y1={source.y} x2={target.x} y2={target.y} markerEnd={marker} />
                  )}
                  {label ? <text className={`pc-control-graph__route-label is-${edge.kind}`} x={((credential?.x ?? source.x ?? 0) + (target.x ?? 0)) / 2} y={((credential?.y ?? source.y ?? 0) + (target.y ?? 0)) / 2 - 9} textAnchor="middle">{visibleNodeLabel(label)}</text> : null}
                  {edge.kind === "elevation" && edge.expiresAt ? <text className="pc-control-graph__edge-label" x={((source.x ?? 0) + (target.x ?? 0)) / 2} y={((source.y ?? 0) + (target.y ?? 0)) / 2 - 7} textAnchor="middle">break glass · {remainingBrief(edge.expiresAt, clock)}</text> : null}
                </g>;
              })}
              {eventPath && shownActiveEvent && !reducedMotion ? (
                <g className={`pc-control-graph__event is-${shownActiveEvent.tone}`} data-event-state={shownActiveEvent.stop}>
                  <path id={`event-path-${shownActiveEvent.id}`} d={eventPath} />
                  <circle r="7" filter="url(#pc-graph-glow)">
                    <animateMotion dur="1.35s" fill="freeze" path={eventPath} />
                  </circle>
                </g>
              ) : null}
              {shownActiveEvent?.receiptRecorded && shownActiveEvent.providerNodeId && nodeMap.get(shownActiveEvent.providerNodeId) ? <text className="pc-control-graph__receipt-marker" x={(nodeMap.get(shownActiveEvent.providerNodeId)?.x ?? 0) + 44} y={(nodeMap.get(shownActiveEvent.providerNodeId)?.y ?? 0) - 34}>receipt recorded</text> : null}
              {shown.nodes.map((node) => {
                const forceNode = nodeMap.get(node.id);
                if (!forceNode) return null;
                const selected = selectedNodeId === node.id;
                const activeStage = shownActiveEvent
                  ? node.id === shownActiveEvent.agentNodeId
                    ? "source"
                    : node.kind === "gate"
                      ? shownActiveEvent.stop === "gate" ? "stopped" : "reached"
                      : node.kind === "credential"
                        ? shownActiveEvent.stop === "credential" ? "stopped" : (["provider", "receipt"].includes(shownActiveEvent.stop) ? "reached" : "idle")
                        : node.kind === "provider" && node.id === shownActiveEvent.providerNodeId
                          ? shownActiveEvent.stop === "provider" ? "stopped" : shownActiveEvent.stop === "receipt" ? "reached" : "idle"
                          : "idle"
                  : "idle";
                return (
                  <g
                    key={node.id}
                    className={`pc-control-graph__node is-${node.kind}`}
                    data-state={node.state}
                    data-selected={selected}
                    data-event-stage={activeStage}
                    transform={`translate(${forceNode.x ?? 0} ${forceNode.y ?? 0})`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${node.kind} ${node.label}, ${node.state}`}
                    onClick={() => setSelectedNodeId(node.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedNodeId(node.id);
                      }
                    }}
                    onDoubleClick={() => {
                      forceNode.fx = null;
                      forceNode.fy = null;
                      simulationRef.current?.alpha(0.45).restart();
                    }}
                    onPointerDown={(event) => {
                      if (!event.isPrimary || event.button !== 0) return;
                      event.stopPropagation();
                      setSelectedNodeId(node.id);
                      svgRef.current?.setPointerCapture(event.pointerId);
                      dragRef.current = node.id;
                      forceNode.fx = forceNode.x;
                      forceNode.fy = forceNode.y;
                      simulationRef.current?.alphaTarget(0.18).restart();
                    }}
                  >
                    <circle r={nodeRadius(node)} />
                    <circle className="pc-control-graph__node-ring" r={nodeRadius(node) + 7} />
                    <text y={nodeRadius(node) + 23} textAnchor="middle">{visibleNodeLabel(node.label)}</text>
                    <text className="pc-control-graph__node-meta" y={nodeRadius(node) + 35} textAnchor="middle">
                      {node.kind === "agent"
                        ? node.state === "armed" ? "emergency blocked" : node.state === "unknown" ? "topology not loaded" : "agent identity"
                        : node.kind === "gate"
                          ? "kill · scope · policy · budget"
                          : node.kind === "credential"
                            ? "key stays server-side"
                            : node.state === "ready" ? "key ready" : node.state === "missing" ? "no key" : "topology not loaded"}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
          {shown.nodes.filter((node) => node.kind === "agent").length === 0 ? (
            <div className="pc-control-graph__empty"><Expand aria-hidden="true" /><strong>No agents yet</strong><span>Create an agent and its capability path will appear here.</span></div>
          ) : shown.events.length === 0 ? (
            <div className="pc-control-graph__waiting">Waiting for a real governed call.</div>
          ) : null}
          <div className="sr-only">
            <h2>Graph relationships</h2>
            <ul>{shown.edges.map((edge) => <li key={edge.id}>{edge.kind}: {shown.nodes.find((node) => node.id === edge.source)?.label} to {shown.nodes.find((node) => node.id === edge.target)?.label}</li>)}</ul>
          </div>
        </div>

        <aside className="pc-control-graph__rail" aria-label="Graph inspector and recent events">
          {presentation ? (
            <section
              className="pc-control-graph__outcome"
              data-outcome-tone={presentationOutcome?.tone ?? "idle"}
              data-stop-boundary={presentationOutcome?.stop ?? "idle"}
            >
              <p className="pc-kicker">Latest new stored event</p>
              {shownActiveEvent && presentationOutcome ? (
                <>
                  <strong>{presentationOutcome.label}</strong>
                  <span>{shown.agents[shownActiveEvent.row.agent_id ?? ""]?.name ?? "Historical identity"}</span>
                  <p>{shownActiveEvent.row.provider ?? "unknown provider"}{shownActiveEvent.row.model ? ` / ${shownActiveEvent.row.model}` : ""}</p>
                  <small>{shownActiveEvent.row.auth_method === "passport" ? "Passport visa" : shownActiveEvent.row.auth_method === "direct_key" ? "Direct Agent Key" : "Stored authentication method unavailable"}</small>
                  {shownActiveEvent.receiptRecorded ? <em>Receipt returned</em> : null}
                </>
              ) : (
                <><strong>STANDING BY</strong><p>Static lines show configured capability routes. They are not calls.</p></>
              )}
            </section>
          ) : null}
          <section className="pc-control-graph__inspector">
            <p className="pc-kicker">Selected object</p>
            {!selectedNode ? <div className="pc-control-graph__explainer"><h2>How a call moves</h2><ol><li><b>Agent asks.</b><span>Its individual identity enters PassControl.</span></li><li><b>PassControl checks.</b><span>Kill switch, suspension, model scope, policy, rate and budget.</span></li><li><b>PassControl uses the key.</b><span>The provider key stays on the server and is never returned to the agent.</span></li><li><b>Provider receives the call.</b><span>Only after every required check allows it.</span></li></ol><p>Static lines show configuration. They do not claim a call happened. Select an agent to reveal its green allowed-model routes.</p></div> : selectedAgent ? (
              <>
                <h2>{selectedAgent.name}</h2>
                <span className="pc-control-graph__state" data-state={selectedAgent.emergencyBlocked ? "armed" : selectedAgent.status}>
                  {selectedAgent.emergencyBlocked ? "Emergency blocked" : selectedAgent.status}
                </span>
                <dl>
                  {!presentation ? <div><dt>Passport suffix</dt><dd><code>{selectedAgent.passportSuffix ? `…${selectedAgent.passportSuffix}` : "Direct-only identity"}</code></dd></div> : null}
                  <div><dt>Normal access</dt><dd>{selectedAgent.scopes.length ? selectedAgent.scopes.map((scope) => `${scope.provider}: ${scope.models.join(", ") || "no models"}`).join(" · ") : "No provider scope"}</dd></div>
                  {!presentation ? <div><dt>Token budget</dt><dd>{selectedAgent.budgetTokens == null ? "Unlimited" : `${selectedAgent.spentTokens.toLocaleString()} / ${selectedAgent.budgetTokens.toLocaleString()}`}</dd></div> : null}
                  {!presentation ? <div><dt>Cost budget</dt><dd>{selectedAgent.budgetCents == null ? "Unlimited" : `$${(selectedAgent.spentMicrocents / 100_000_000).toFixed(2)} / $${(selectedAgent.budgetCents / 100).toFixed(2)}`}</dd></div> : null}
                  <div><dt>Live policy</dt><dd>{selectedAgent.policyEnabled ? "Configured" : "No additional policy"}</dd></div>
                  <div><dt>Break glass</dt><dd>{selectedAgent.elevationExpiresAt ? <>Open until <DashboardTimestamp value={selectedAgent.elevationExpiresAt} kind="short" /></> : "Closed"}</dd></div>
                </dl>
                {!presentation ? <div className="pc-control-graph__links"><Link href={`/dashboard/agents/${selectedAgent.id}#agent-identity`}>Identity</Link><Link href={`/dashboard/agents/${selectedAgent.id}#agent-policy`}>Policy</Link><Link href={`/dashboard/agents/${selectedAgent.id}#agent-activity`}>Activity</Link></div> : null}
              </>
            ) : selectedNode.kind === "provider" ? (
              <><h2>{selectedNode.label}</h2><span className="pc-control-graph__state" data-state={selectedNode.state}>{selectedNode.state === "ready" ? "Provider key ready" : selectedNode.state === "missing" ? "Provider key missing" : "Topology not loaded"}</span><p>{selectedProviderAgents.length ? `Reachable by ${[...new Set(selectedProviderAgents)].join(", ")}.` : "No current agent capability reaches this provider."}</p></>
            ) : selectedNode.kind === "credential" ? (
              <><h2>Server-side provider key</h2><span className="pc-control-graph__state" data-state={selectedNode.state}>Credential boundary</span><p>PassControl reaches this stage only after the call passes its checks and reserves budget. The provider key is injected here and never sent back to the agent.</p></>
            ) : (
              <><h2>{selectedNode.label}</h2><span className="pc-control-graph__state" data-state={selectedNode.state}>{selectedNode.state === "armed" ? "Kill switch armed" : "Checking eligible calls"}</span><p>This is the decision point: kill state, suspension, model scope, live policy, rate limit and budget checks run here. A refusal stops here; it never reaches the provider.</p></>
            )}
          </section>

          <section className="pc-control-graph__events">
            <div><p className="pc-kicker">Recorded events</p><span>newest first · {shown.events.length}</span></div>
            <p className="pc-control-graph__event-key"><span className="is-allowed">Allowed</span><span className="is-blocked">Stopped</span><span className="is-warning">Provider/setup issue</span></p>
            {shown.events.length ? <ol>{shown.events.map((event, index) => {
              const origin = liveEventIdsRef.current.has(snapshot.events[index]?.id ?? "") ? "live" : "stored";
              return (
              <li key={event.id} data-tone={event.tone} data-event-origin={origin} data-stop-boundary={event.stop}>
                <button type="button" disabled={presentation} onClick={() => setSelectedRow(event.row)}>
                  <span>{event.row.provider ?? "unknown"}{event.row.model ? ` / ${event.row.model}` : ""}</span>
                  <strong>{shortStatus(event)}</strong>
                  <small>{presentation ? (origin === "live" ? "Newly recorded" : "Stored event") : <><DashboardTimestamp value={event.row.created_at} kind="time" />{event.receiptRecorded ? " · receipt recorded" : ""}</>}</small>
                </button>
              </li>
            );})}</ol> : <p className="pc-control-graph__hint">No stored calls yet. The graph will stay still until one arrives.</p>}
          </section>
        </aside>
      </div>

      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {shownActiveEvent ? `New governed call: ${shownActiveEvent.label}.` : ""}
      </div>
      {!presentation ? <CallDetailDrawer row={selectedRow} open={Boolean(selectedRow)} onOpenChange={(open) => !open && setSelectedRow(null)} currentShadowRevision={selectedRow?.agent_id ? callContext.shadowRevisions[selectedRow.agent_id] ?? null : null} /> : null}
    </div>
  );
}
