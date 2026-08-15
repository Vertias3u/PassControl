"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Clock3 } from "lucide-react";

const STORAGE_KEY = "passcontrol.dashboard.time-zone";

export type DashboardTimeMode = "utc" | "local";
export type DashboardTimeKind = "time" | "date" | "datetime" | "short";

interface DashboardTimeContextValue {
  mode: DashboardTimeMode;
  timeZone: string;
  zoneLabel: string;
  setMode: (mode: DashboardTimeMode) => void;
  format: (value: string | number | Date | null | undefined, kind?: DashboardTimeKind) => string;
}

function safeLocalZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const DEFAULT_TIME_CONTEXT: DashboardTimeContextValue = {
  mode: "utc",
  timeZone: "UTC",
  zoneLabel: "UTC",
  setMode: () => {},
  format: (input, kind = "datetime") => {
    if (input === null || input === undefined || input === "") return "Not recorded";
    const date = input instanceof Date ? input : new Date(input);
    if (!Number.isFinite(date.getTime())) return "Unknown time";
    return new Intl.DateTimeFormat("en-GB", options(kind, "UTC")).format(date);
  },
};

// UTC is a safe standalone default for isolated component renders and tests.
// Authenticated pages always replace it with DashboardTimeProvider.
const DashboardTimeContext = createContext<DashboardTimeContextValue>(DEFAULT_TIME_CONTEXT);

function options(kind: DashboardTimeKind, timeZone: string): Intl.DateTimeFormatOptions {
  const zone: Intl.DateTimeFormatOptions = { timeZone, timeZoneName: "short" };
  if (kind === "time") {
    return { ...zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };
  }
  if (kind === "date") {
    return { ...zone, day: "2-digit", month: "short", year: "numeric" };
  }
  if (kind === "short") {
    return { ...zone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false };
  }
  return {
    ...zone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  };
}

export function DashboardTimeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<DashboardTimeMode>("utc");
  const localZone = useMemo(safeLocalZone, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "utc" || stored === "local") setModeState(stored);
    } catch {
      // Storage can be disabled. The in-memory UTC default remains honest.
    }
  }, []);

  const setMode = (next: DashboardTimeMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The switch still applies for this tab when storage is unavailable.
    }
  };

  const timeZone = mode === "utc" ? "UTC" : localZone;
  const zoneLabel = mode === "utc" ? "UTC" : localZone;
  const value = useMemo<DashboardTimeContextValue>(() => ({
    mode,
    timeZone,
    zoneLabel,
    setMode,
    format: (input, kind = "datetime") => {
      if (input === null || input === undefined || input === "") return "Not recorded";
      const date = input instanceof Date ? input : new Date(input);
      if (!Number.isFinite(date.getTime())) return "Unknown time";
      return new Intl.DateTimeFormat("en-GB", options(kind, timeZone)).format(date);
    },
  }), [mode, timeZone, zoneLabel]);

  return <DashboardTimeContext.Provider value={value}>{children}</DashboardTimeContext.Provider>;
}

export function useDashboardTime(): DashboardTimeContextValue {
  return useContext(DashboardTimeContext);
}

export function TimeZoneToggle() {
  const { mode, setMode, zoneLabel } = useDashboardTime();
  return (
    <div className="pc-time-zone" data-state={mode} aria-label={`Dashboard time zone: ${zoneLabel}`}>
      <Clock3 aria-hidden="true" />
      <div className="pc-time-zone__options" role="group" aria-label="Timestamp display">
        <button type="button" aria-pressed={mode === "utc"} onClick={() => setMode("utc")}>UTC</button>
        <button type="button" aria-pressed={mode === "local"} onClick={() => setMode("local")}>Local</button>
      </div>
      <span className="pc-time-zone__label">{zoneLabel}</span>
    </div>
  );
}

export function DashboardTimestamp({
  value,
  kind = "datetime",
  fallback = "Not recorded",
  className,
}: {
  value: string | number | Date | null | undefined;
  kind?: DashboardTimeKind;
  fallback?: string;
  className?: string;
}) {
  const { format } = useDashboardTime();
  if (value === null || value === undefined || value === "") return <span className={className}>{fallback}</span>;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) return <span className={className}>{fallback}</span>;
  return <time className={className} dateTime={parsed.toISOString()}>{format(parsed, kind)}</time>;
}
