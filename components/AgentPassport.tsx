"use client";

import { useMemo, useRef, useState } from "react";
import type { AgentPassportView } from "@/app/dashboard/agents/[id]/passport-data";
import type { LogEntry } from "@/lib/log";
import { createPassportSigil, passportIdForDisplay } from "@/lib/passport-art";
import { ScopeEditor } from "./ScopeEditor";
import { FallbackEditor } from "./FallbackEditor";
import { CapabilityHistory } from "./CapabilityHistory";
import { DirectAgentIdentity } from "./DirectAgentIdentity";
import styles from "./AgentPassport.module.css";
import { useDashboardTime } from "@/components/dashboard/DashboardTime";

const SVG_SIZE = 960;
const EXPORT_SCALE = 2;

const PALETTE = {
  ink: "#0b0f0d",
  panel: "#111714",
  panelHigh: "#182019",
  paper: "#eef4eb",
  muted: "#93a094",
  quiet: "#657166",
  line: "#344137",
  signal: "#b7f34a",
  warning: "#f59e0b",
  danger: "#ef4444",
  info: "#22d3ee",
} as const;

function cleanedText(value: string, maxLength: number): string {
  const safe = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  const chars = Array.from(safe);
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join("")}…` : safe;
}

function machineText(value: string, maxLength: number): string {
  const ascii = cleanedText(value, maxLength * 2)
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "<")
    .replace(/<+/g, "<");
  return ascii.slice(0, maxLength).padEnd(maxLength, "<");
}

function formatUsdFromMicrocents(value: number): string {
  const dollars = value / 100_000_000;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: dollars > 0 && dollars < 0.01 ? 4 : 2,
    maximumFractionDigits: dollars > 0 && dollars < 0.01 ? 4 : 2,
  }).format(dollars);
}

function formatUsdFromCents(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100);
}

function lifecycleColor(status: string): string {
  if (status === "active") return PALETTE.signal;
  if (status === "suspended") return PALETTE.warning;
  return PALETTE.danger;
}

function lifecycleClasses(status: string): string {
  if (status === "active") return "border-success/40 bg-success/10 text-success";
  if (status === "suspended") return "border-warning/40 bg-warning/10 text-warning";
  return "border-danger/40 bg-danger/10 text-danger";
}

function verdictClasses(status: string): string {
  if (status === "ok") return "border-success/30 bg-success/10 text-success";
  if (status.startsWith("blocked_")) return "border-danger/30 bg-danger/10 text-danger";
  if (status === "upstream_error") return "border-warning/30 bg-warning/10 text-warning";
  return "border-border bg-secondary text-muted-foreground";
}

// Keyed by LogEntry["status"] rather than `string`, so a new audit status fails
// to compile here instead of rendering as "Unknown". This map was a plain
// Record<string, string> and had already missed blocked_policy — the third
// place the same drift landed. `import type` is erased, so no server code
// reaches the client.
const VERDICT_LABELS: Record<LogEntry["status"], string> = {
  ok: "Allowed",
  blocked_budget: "Budget exceeded",
  blocked_endpoint: "Endpoint blocked",
  blocked_killed: "Kill switch",
  blocked_suspended: "Agent suspended",
  blocked_scope: "Scope violation",
  blocked_policy: "Policy rule",
  provider_exhausted: "Provider out of credit",
  no_provider_key: "No provider key stored",
  upstream_error: "Provider error",
};

function verdictLabel(status: string): string {
  return (
    VERDICT_LABELS[status as LogEntry["status"]] ??
    `Unknown · ${cleanedText(status, 28) || "unlabelled"}`
  );
}

function slug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "agent"
  );
}

function BudgetGauge({
  x,
  y,
  label,
  value,
  percent,
  unlimited,
}: {
  x: number;
  y: number;
  label: string;
  value: string;
  percent: number;
  unlimited: boolean;
}) {
  const width = 370;
  const fill = Math.max(0, Math.min(100, percent));
  return (
    <g>
      <text
        x={x}
        y={y}
        fill={PALETTE.muted}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="15"
        fontWeight="700"
        letterSpacing="1.6"
      >
        {label}
      </text>
      <text
        x={x}
        y={y + 29}
        fill={PALETTE.paper}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="18"
        fontWeight="700"
      >
        {unlimited ? "UNLIMITED" : value}
      </text>
      {unlimited ? null : (
        <>
          <rect x={x} y={y + 43} width={width} height="10" rx="5" fill={PALETTE.line} />
          <rect
            x={x}
            y={y + 43}
            width={(width * fill) / 100}
            height="10"
            rx="5"
            fill={fill >= 100 ? PALETTE.danger : PALETTE.signal}
          />
          <text
            x={x + width}
            y={y + 29}
            textAnchor="end"
            fill={fill >= 100 ? PALETTE.danger : PALETTE.muted}
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            fontSize="15"
            fontWeight="700"
          >
            {Math.round(percent)}%
          </text>
        </>
      )}
    </g>
  );
}

function PassportSvg({
  passport,
  showFullId,
  svgRef,
}: {
  passport: AgentPassportView;
  showFullId: boolean;
  svgRef: React.RefObject<SVGSVGElement>;
}) {
  const { format } = useDashboardTime();
  const sigil = useMemo(
    () => createPassportSigil(passport.agent.passportId),
    [passport.agent.passportId]
  );
  const displayedId = passportIdForDisplay(passport.agent.passportId, showFullId);
  const holder = cleanedText(passport.agent.name, 26) || "Unnamed agent";
  const status = cleanedText(passport.agent.status, 18).toUpperCase();
  const visas = passport.visas.slice(0, 3);
  const stamps = passport.providerStamps.slice(0, 4);
  const machineId = showFullId
    ? machineText(passport.agent.passportId, 46)
    : `${machineText(passport.agent.passportId.slice(0, 8), 8)}<REDACTED<<<<<<<<<<<<<<<<<<<`;
  const machineStrip = `PCAI<${machineText(holder, 24)}<<${machineId}`;
  const tokenValue =
    passport.budgets.tokens.capTokens == null
      ? "UNLIMITED"
      : `${passport.budgets.tokens.spentTokens.toLocaleString("en-US")} / ${passport.budgets.tokens.capTokens.toLocaleString("en-US")} TOKENS`;
  const costValue =
    passport.budgets.cost.capCents == null
      ? "UNLIMITED"
      : `${formatUsdFromMicrocents(passport.budgets.cost.spentMicrocents)} / ${formatUsdFromCents(passport.budgets.cost.capCents)}`;

  return (
    <svg
      ref={svgRef}
      data-passport-svg="export"
      className="block h-auto w-full"
      viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
      role="img"
      aria-labelledby="passport-svg-title passport-svg-description"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title id="passport-svg-title">{`Agent passport for ${holder}`}</title>
      <desc id="passport-svg-description">
        Registry identity, scoped visas, recorded provider entries, and reconciled budgets.
      </desc>

      <rect width={SVG_SIZE} height={SVG_SIZE} rx="28" fill={PALETTE.ink} />
      <rect
        x="12"
        y="12"
        width="936"
        height="936"
        rx="20"
        fill="none"
        stroke={PALETTE.line}
        strokeWidth="2"
      />
      <path d="M36 96H924" stroke={PALETTE.line} strokeWidth="2" />
      <circle cx="62" cy="54" r="18" fill={PALETTE.signal} opacity="0.14" />
      <path
        d="M62 69C59 60 49 51 49 40C49 33 54 29 58 32C62 35 62 48 62 56C63 47 64 35 68 32C72 29 77 33 75 41C73 51 65 61 62 69Z"
        fill={PALETTE.signal}
      />
      <text
        x="92"
        y="50"
        fill={PALETTE.paper}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="23"
        fontWeight="800"
        letterSpacing="-0.6"
      >
        PASSCONTROL
      </text>
      <text
        x="92"
        y="72"
        fill={PALETTE.muted}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="13"
        fontWeight="700"
        letterSpacing="2.2"
      >
        AGENT IDENTITY DOCUMENT
      </text>
      <text
        x="902"
        y="59"
        textAnchor="end"
        fill={PALETTE.signal}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="16"
        fontWeight="800"
        letterSpacing="1.8"
      >
        WORK-VISA CONTROL
      </text>

      <rect x="46" y="126" width="284" height="284" rx="18" fill={sigil.background} />
      <rect
        x="55"
        y="135"
        width="266"
        height="266"
        rx="13"
        fill="none"
        stroke={sigil.accent}
        strokeWidth="2"
        opacity="0.55"
      />
      <circle cx="188" cy="268" r="104" fill={sigil.accent} opacity="0.08" />
      {sigil.cells.map((cell, index) => (
        <rect
          key={`${cell.x}-${cell.y}-${index}`}
          x={78 + cell.x * 32}
          y={158 + cell.y * 32}
          width="27"
          height="27"
          rx={(cell.x + cell.y + index) % 3 === 0 ? 13.5 : 6}
          fill={(cell.x + cell.y) % 3 === 0 ? sigil.accent : sigil.foreground}
          opacity={(cell.x + cell.y) % 4 === 0 ? 0.78 : 1}
        />
      ))}
      <text
        x="188"
        y="440"
        textAnchor="middle"
        fill={PALETTE.muted}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="13"
        fontWeight="700"
        letterSpacing="1.8"
      >
        ED25519 HOLDER SIGIL
      </text>

      <text
        x="382"
        y="143"
        fill={PALETTE.muted}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="14"
        fontWeight="700"
        letterSpacing="1.8"
      >
        HOLDER
      </text>
      <text
        x="382"
        y="184"
        fill={PALETTE.paper}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="32"
        fontWeight="800"
      >
        {holder}
      </text>
      <path d="M382 204H914" stroke={PALETTE.line} />

      <text
        x="382"
        y="237"
        fill={PALETTE.muted}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="14"
        fontWeight="700"
        letterSpacing="1.8"
      >
        PASSPORT ID · PUBLIC KEY
      </text>
      <text
        x="382"
        y="275"
        fill={PALETTE.paper}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize={showFullId ? "17" : "28"}
        fontWeight="700"
        letterSpacing={showFullId ? "0.2" : "1.2"}
      >
        {displayedId}
      </text>
      <path d="M382 295H914" stroke={PALETTE.line} />

      <text
        x="382"
        y="328"
        fill={PALETTE.muted}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="14"
        fontWeight="700"
        letterSpacing="1.8"
      >
        REGISTRY STATUS
      </text>
      <circle cx="394" cy="363" r="7" fill={lifecycleColor(passport.agent.status)} />
      <text
        x="412"
        y="370"
        fill={lifecycleColor(passport.agent.status)}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="22"
        fontWeight="800"
        letterSpacing="1.2"
      >
        {status}
      </text>
      <text
        x="650"
        y="328"
        fill={PALETTE.muted}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="14"
        fontWeight="700"
        letterSpacing="1.8"
      >
        ISSUED
      </text>
      <text
        x="650"
        y="370"
        fill={PALETTE.paper}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="20"
        fontWeight="700"
      >
        {format(passport.agent.issuedAt, "date")}
      </text>
      <text
        x="382"
        y="404"
        fill={PALETTE.muted}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="14"
        fontWeight="700"
        letterSpacing="1.8"
      >
        LAST AUTHENTICATED
      </text>
      <text
        x="650"
        y="404"
        fill={PALETTE.muted}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="14"
        fontWeight="700"
        letterSpacing="1.8"
      >
        DOCUMENT CLASS
      </text>
      <text
        x="382"
        y="438"
        fill={PALETTE.paper}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="18"
        fontWeight="700"
      >
        {format(passport.agent.lastEntryAt)}
      </text>
      <text
        x="650"
        y="438"
        fill={PALETTE.paper}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="18"
        fontWeight="700"
      >
        PC / NON-HUMAN IDENTITY
      </text>

      <path d="M46 477H914" stroke={PALETTE.line} strokeWidth="2" />
      <BudgetGauge
        x={72}
        y={510}
        label="TOKEN LIMIT · RECONCILED"
        value={tokenValue}
        percent={passport.budgets.tokens.percentUsed}
        unlimited={passport.budgets.tokens.unlimited}
      />
      <BudgetGauge
        x={520}
        y={510}
        label="COST LIMIT · RECONCILED"
        value={costValue}
        percent={passport.budgets.cost.percentUsed}
        unlimited={passport.budgets.cost.unlimited}
      />

      <text
        x="46"
        y="608"
        fill={PALETTE.muted}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="14"
        fontWeight="700"
        letterSpacing="1.8"
      >
        VISAS · ALLOWED SCOPES
      </text>
      {visas.length === 0 ? (
        <text
          x="46"
          y="652"
          fill={PALETTE.warning}
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          fontSize="18"
          fontWeight="700"
        >
          NO SCOPES — THIS PASSPORT CAN REACH NOTHING
        </text>
      ) : (
        visas.map((visa, index) => {
          const x = 46 + index * 300;
          return (
            <g key={`${visa.provider}-${index}`}>
              <rect
                x={x}
                y="626"
                width="280"
                height="73"
                rx="10"
                fill={PALETTE.panelHigh}
                stroke={PALETTE.line}
              />
              <text
                x={x + 16}
                y="653"
                fill={PALETTE.signal}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                fontSize="17"
                fontWeight="800"
                letterSpacing="0.8"
              >
                {cleanedText(visa.provider, 22).toUpperCase()}
              </text>
              <text
                x={x + 16}
                y="681"
                fill={PALETTE.muted}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                fontSize="13"
                fontWeight="600"
              >
                {cleanedText(visa.models.join(" · "), 35) || "No models"}
              </text>
            </g>
          );
        })
      )}
      {passport.visas.length > 3 ? (
        <text
          x="914"
          y="608"
          textAnchor="end"
          fill={PALETTE.muted}
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          fontSize="13"
        >
          +{passport.visas.length - 3} MORE
        </text>
      ) : null}

      <text
        x="46"
        y="747"
        fill={PALETTE.muted}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="14"
        fontWeight="700"
        letterSpacing="1.8"
      >
        PROVIDER ENTRY STAMPS · SUCCESSFUL RECORDED CALLS
      </text>
      {stamps.length === 0 ? (
        <text
          x="46"
          y="794"
          fill={PALETTE.muted}
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          fontSize="18"
          fontWeight="700"
        >
          NO RECORDED ENTRIES
        </text>
      ) : (
        stamps.map((stamp, index) => {
          const x = 46 + index * 216;
          return (
            <g key={`${stamp.provider}-${index}`}>
              <rect
                x={x}
                y="765"
                width="198"
                height="76"
                rx="38"
                fill="none"
                stroke={index % 2 === 0 ? PALETTE.info : PALETTE.signal}
                strokeWidth="2"
                opacity="0.76"
              />
              <text
                x={x + 99}
                y="796"
                textAnchor="middle"
                fill={PALETTE.paper}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                fontSize="16"
                fontWeight="800"
              >
                {cleanedText(stamp.provider, 18).toUpperCase()}
              </text>
              <text
                x={x + 99}
                y="820"
                textAnchor="middle"
                fill={PALETTE.muted}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                fontSize="13"
                fontWeight="700"
              >
                {stamp.recordedCalls.toLocaleString("en-US")} ENTR
                {stamp.recordedCalls === 1 ? "Y" : "IES"}
              </text>
            </g>
          );
        })
      )}
      {passport.providerStamps.length > 4 ? (
        <text
          x="914"
          y="747"
          textAnchor="end"
          fill={PALETTE.muted}
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          fontSize="13"
        >
          +{passport.providerStamps.length - 4} MORE
        </text>
      ) : null}

      <rect x="36" y="866" width="888" height="60" rx="6" fill={PALETTE.panelHigh} />
      <text
        x="53"
        y="893"
        fill={PALETTE.signal}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="15"
        fontWeight="700"
        letterSpacing="1.1"
      >
        {machineStrip.slice(0, 84)}
      </text>
      <text
        x="53"
        y="916"
        fill={PALETTE.muted}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="13"
        fontWeight="700"
        letterSpacing="1.4"
      >
        ED25519&lt;&lt;SCOPED&lt;WORK&lt;VISA&lt;&lt;VERIFY&lt;THEN&lt;FORWARD&lt;&lt;&lt;
      </text>
    </svg>
  );
}

function MobilePassportCard({
  passport,
  showFullId,
}: {
  passport: AgentPassportView;
  showFullId: boolean;
}) {
  const { format } = useDashboardTime();
  const sigil = useMemo(
    () => createPassportSigil(passport.agent.passportId),
    [passport.agent.passportId]
  );
  const displayedId = passportIdForDisplay(passport.agent.passportId, showFullId);
  const tokenLimit =
    passport.budgets.tokens.capTokens == null
      ? "unlimited"
      : `${passport.budgets.tokens.spentTokens.toLocaleString("en-US")} / ${passport.budgets.tokens.capTokens.toLocaleString("en-US")} tokens`;
  const costLimit =
    passport.budgets.cost.capCents == null
      ? "unlimited"
      : `${formatUsdFromMicrocents(passport.budgets.cost.spentMicrocents)} / ${formatUsdFromCents(passport.budgets.cost.capCents)}`;

  return (
    <div
      data-passport-mobile="true"
      className={`${styles.mobileCard} gap-4 rounded-2xl border border-border bg-[#0b0f0d] p-4`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
        <div>
          <p className="m-0 text-sm font-extrabold tracking-tight text-foreground">PASSCONTROL</p>
          <p className="mt-1 text-[0.65rem] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            Agent identity document
          </p>
        </div>
        <span className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-primary">
          Work-visa control
        </span>
      </div>

      <div className={styles.identityGrid}>
        <svg
          className="h-auto w-full rounded-xl"
          viewBox="0 0 112 112"
          role="img"
          aria-label="Deterministic holder sigil"
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect width="112" height="112" rx="12" fill={sigil.background} />
          {sigil.cells.map((cell, index) => (
            <rect
              key={`${cell.x}-${cell.y}-${index}`}
              x={10 + cell.x * 13}
              y={10 + cell.y * 13}
              width="11"
              height="11"
              rx={(cell.x + cell.y + index) % 3 === 0 ? 5.5 : 2.5}
              fill={(cell.x + cell.y) % 3 === 0 ? sigil.accent : sigil.foreground}
            />
          ))}
        </svg>
        <div className="min-w-0">
          <p className="m-0 text-[0.65rem] font-bold uppercase tracking-[0.14em] text-muted-foreground">
            Holder
          </p>
          <p className="mt-1 break-words text-base font-extrabold leading-5 text-foreground">
            {cleanedText(passport.agent.name, 80) || "Unnamed agent"}
          </p>
          <span
            className={`mt-3 inline-flex rounded-full border px-2 py-1 text-[0.65rem] font-bold uppercase ${lifecycleClasses(
              passport.agent.status
            )}`}
          >
            Registry · {cleanedText(passport.agent.status, 20)}
          </span>
        </div>
      </div>

      <dl className="m-0 grid gap-3 text-xs">
        <div>
          <dt className="font-bold uppercase tracking-[0.12em] text-muted-foreground">
            Passport ID · public key
          </dt>
          <dd className="mt-1 break-all text-sm font-bold text-foreground">{displayedId}</dd>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <dt className="font-bold uppercase tracking-[0.12em] text-muted-foreground">Issued</dt>
            <dd className="mt-1 text-foreground">{format(passport.agent.issuedAt, "date")}</dd>
          </div>
          <div>
            <dt className="font-bold uppercase tracking-[0.12em] text-muted-foreground">
              Last authenticated
            </dt>
            <dd className="mt-1 text-foreground">
              {format(passport.agent.lastEntryAt)}
            </dd>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 border-t border-border pt-3">
          <div>
            <dt className="font-bold uppercase tracking-[0.12em] text-muted-foreground">
              Token limit
            </dt>
            <dd className="mt-1 break-words text-foreground">{tokenLimit}</dd>
          </div>
          <div>
            <dt className="font-bold uppercase tracking-[0.12em] text-muted-foreground">
              Cost limit
            </dt>
            <dd className="mt-1 break-words text-foreground">{costLimit}</dd>
          </div>
        </div>
      </dl>

      <div className="rounded-lg bg-secondary/70 px-3 py-2">
        <p className="m-0 break-all text-[0.62rem] font-bold leading-4 tracking-[0.08em] text-primary">
          PCAI&lt;{machineText(passport.agent.name, 18)}&lt;&lt;
          {showFullId
            ? machineText(passport.agent.passportId, 46)
            : `${machineText(passport.agent.passportId.slice(0, 8), 8)}<REDACTED`}
        </p>
      </div>
    </div>
  );
}

export function AgentPassport({
  passport,
  visaTtlSeconds,
}: {
  passport: AgentPassportView;
  // Passed in rather than read here: this is a client component and the TTL
  // comes from a server-side env var. See ScopeEditor for why it is never typed
  // as a literal.
  visaTtlSeconds: number;
}) {
  const { format } = useDashboardTime();
  const svgRef = useRef<SVGSVGElement>(null);
  const [editingScopes, setEditingScopes] = useState(false);
  const [editingFallbacks, setEditingFallbacks] = useState(false);
  const [showFullId, setShowFullId] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [downloadState, setDownloadState] = useState<
    "idle" | "working" | "complete" | "failed"
  >("idle");
  const [actionMessage, setActionMessage] = useState("");

  const copyPassportId = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(passport.agent.passportId);
      setCopyState("copied");
      setActionMessage("Full public passport ID copied.");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("failed");
      setActionMessage("Copy failed. Your browser may block clipboard access.");
    }
  };

  const downloadPassport = async () => {
    const source = svgRef.current;
    if (!source || downloadState === "working") return;
    setDownloadState("working");
    setActionMessage("Preparing PNG…");

    let sourceUrl: string | null = null;
    try {
      const clone = source.cloneNode(true) as SVGSVGElement;
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("width", String(SVG_SIZE));
      clone.setAttribute("height", String(SVG_SIZE));
      const serialized = new XMLSerializer().serializeToString(clone);
      if (!showFullId && serialized.includes(passport.agent.passportId)) {
        throw new Error("Redaction check failed");
      }

      sourceUrl = URL.createObjectURL(
        new Blob([serialized], { type: "image/svg+xml;charset=utf-8" })
      );
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Unable to load passport artwork"));
        image.src = sourceUrl!;
      });

      const canvas = document.createElement("canvas");
      canvas.width = SVG_SIZE * EXPORT_SCALE;
      canvas.height = SVG_SIZE * EXPORT_SCALE;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      const png = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))),
          "image/png"
        );
      });
      const pngUrl = URL.createObjectURL(png);
      const anchor = document.createElement("a");
      anchor.href = pngUrl;
      anchor.download = `${slug(passport.agent.name)}-agent-passport${
        showFullId ? "-full-id" : "-redacted"
      }.png`;
      anchor.rel = "noopener";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(pngUrl), 1000);

      setDownloadState("complete");
      setActionMessage(
        showFullId
          ? "PNG downloaded with the full public passport ID."
          : "Redacted PNG downloaded."
      );
      window.setTimeout(() => setDownloadState("idle"), 1800);
    } catch {
      setDownloadState("failed");
      setActionMessage("PNG export failed. Try again in a modern browser.");
    } finally {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    }
  };

  return (
    <>
      {passport.agent.passportId ? (
      <section className="grid gap-4" aria-labelledby="agent-passport-heading">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="m-0 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Agent identity registry
            </p>
            <h2
              id="agent-passport-heading"
              className="mt-2 break-words text-2xl font-bold tracking-tight text-foreground sm:text-3xl"
            >
              {cleanedText(passport.agent.name, 80) || "Unnamed agent"}
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              A public-key identity document. Registry status is separate from tenant and
              platform kill-switch state.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:items-end">
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={copyPassportId}
                className="rounded-lg border border-border bg-secondary px-3 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {copyState === "copied" ? "Copied" : "Copy full public ID"}
              </button>
              <button
                type="button"
                onClick={downloadPassport}
                disabled={downloadState === "working"}
                className="rounded-lg border border-primary bg-primary px-3 py-2 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {downloadState === "working" ? "Preparing PNG…" : "Download as PNG"}
              </button>
            </div>
            <label className="flex max-w-sm cursor-pointer items-start gap-2 text-xs leading-5 text-muted-foreground">
              <input
                type="checkbox"
                checked={showFullId}
                onChange={(event) => setShowFullId(event.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-primary"
              />
              <span>Include the full public passport ID in the card and exported PNG.</span>
            </label>
          </div>
        </div>

        <p className="sr-only" aria-live="polite">
          {actionMessage}
        </p>
        {copyState === "failed" || downloadState === "failed" ? (
          <p className="m-0 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {actionMessage}
          </p>
        ) : null}

        <div
          data-passport-desktop="true"
          className={`${styles.desktopCard} overflow-hidden rounded-2xl border border-border bg-[#0b0f0d] shadow-2xl shadow-black/30`}
        >
          <PassportSvg passport={passport} showFullId={showFullId} svgRef={svgRef} />
        </div>
        <MobilePassportCard passport={passport} showFullId={showFullId} />
        <dl className="sr-only">
          <dt>Holder</dt>
          <dd>{passport.agent.name}</dd>
          <dt>Public passport ID</dt>
          <dd>{passportIdForDisplay(passport.agent.passportId, showFullId)}</dd>
          <dt>Registry status</dt>
          <dd>{passport.agent.status}</dd>
          <dt>Issued</dt>
          <dd>{format(passport.agent.issuedAt, "date")}</dd>
          <dt>Last authenticated</dt>
          <dd>{format(passport.agent.lastEntryAt)}</dd>
          <dt>Token limit</dt>
          <dd>
            {passport.budgets.tokens.capTokens == null
              ? "unlimited"
              : `${passport.budgets.tokens.spentTokens} of ${passport.budgets.tokens.capTokens} tokens recorded`}
          </dd>
          <dt>Cost limit</dt>
          <dd>
            {passport.budgets.cost.capCents == null
              ? "unlimited"
              : `${formatUsdFromMicrocents(
                  passport.budgets.cost.spentMicrocents
                )} of ${formatUsdFromCents(passport.budgets.cost.capCents)} recorded`}
          </dd>
        </dl>
        <p className="m-0 text-xs leading-5 text-muted-foreground">
          Textual ID redaction does not make the image anonymous: the deterministic holder
          sigil remains a stable fingerprint of the public key.
        </p>
      </section>
      ) : (
        <DirectAgentIdentity passport={passport} />
      )}

      <section
        className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:p-6"
        aria-labelledby="passport-visas-heading"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="m-0 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Capability record
            </p>
            <h2 id="passport-visas-heading" className="mt-2 text-lg font-bold">
              Visas
            </h2>
          </div>
          {editingScopes ? null : (
            <button type="button" className="ghost" onClick={() => setEditingScopes(true)}>
              Edit scopes
            </button>
          )}
        </div>
        {editingScopes ? (
          <ScopeEditor
            agentId={passport.agent.id}
            scopes={passport.visas}
            ttlSeconds={visaTtlSeconds}
            onClose={() => setEditingScopes(false)}
          />
        ) : passport.visas.length === 0 ? (
          <div className="rounded-lg border border-warning/30 bg-warning/10 p-4">
            <p className="m-0 font-semibold text-warning">
              No scopes — this passport can reach nothing.
            </p>
          </div>
        ) : (
          <ul className="m-0 grid list-none gap-3 p-0 md:grid-cols-2 xl:grid-cols-3">
            {passport.visas.map((visa, index) => (
              <li
                key={`${visa.provider}-${index}`}
                className="min-w-0 rounded-lg border border-border bg-secondary/40 p-4"
              >
                <p className="m-0 text-xs font-bold uppercase tracking-[0.14em] text-primary">
                  {cleanedText(visa.provider, 40)}
                </p>
                <p className="mt-2 break-words text-sm leading-6 text-foreground">
                  {visa.models.length
                    ? visa.models.map((model) => cleanedText(model, 100)).join(" · ")
                    : "No model patterns"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:p-6"
        aria-labelledby="passport-fallbacks-heading"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="m-0 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Onward routing
            </p>
            <h2 id="passport-fallbacks-heading" className="mt-2 text-lg font-bold">
              Fallback providers
            </h2>
          </div>
          {editingFallbacks ? null : (
            <button type="button" className="ghost" onClick={() => setEditingFallbacks(true)}>
              {passport.fallbacks.length === 0 ? "Set up failover" : "Edit fallbacks"}
            </button>
          )}
        </div>
        {editingFallbacks ? (
          <FallbackEditor
            agentId={passport.agent.id}
            fallbacks={passport.fallbacks}
            scopes={passport.visas}
            onClose={() => setEditingFallbacks(false)}
          />
        ) : passport.fallbacks.length === 0 ? (
          <p className="m-0 rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">
            None. A call this passport&rsquo;s provider refuses comes straight back to the agent.
          </p>
        ) : (
          <ol className="m-0 grid list-none gap-3 p-0 md:grid-cols-2 xl:grid-cols-3">
            {passport.fallbacks.map((fallback, index) => (
              <li
                key={`${fallback.provider}-${index}`}
                className="min-w-0 rounded-lg border border-border bg-secondary/40 p-4"
              >
                <p className="m-0 text-xs font-bold uppercase tracking-[0.14em] text-primary">
                  {index + 1} · {cleanedText(fallback.provider, 40)}
                </p>
                <p className="mt-2 break-words text-sm leading-6 text-foreground">
                  {cleanedText(fallback.model, 100)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section
        className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:p-6"
        aria-labelledby="passport-history-heading"
      >
        <div>
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            What was changed, and when
          </p>
          <h2 id="passport-history-heading" className="mt-2 text-lg font-bold">
            Amendments
          </h2>
        </div>
        <CapabilityHistory history={passport.history} />
      </section>

      <section className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:p-6">
        <div>
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Successful provider use
          </p>
          <h2 className="mt-2 text-lg font-bold">Entry stamps</h2>
        </div>
        {passport.providerStamps.length === 0 ? (
          <p className="m-0 rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">
            No recorded entries yet. The document is ready for its first admitted call.
          </p>
        ) : (
          <ul className="m-0 grid list-none gap-3 p-0 md:grid-cols-2 xl:grid-cols-3">
            {passport.providerStamps.map((stamp) => (
              <li
                key={stamp.provider}
                className="rounded-lg border border-info/30 bg-info/5 p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <p className="m-0 font-bold uppercase tracking-[0.08em] text-foreground">
                    {cleanedText(stamp.provider, 40)}
                  </p>
                  <span className="rounded-full border border-info/40 px-2 py-0.5 text-xs font-bold text-info">
                    {stamp.recordedCalls.toLocaleString("en-US")}
                  </span>
                </div>
                <dl className="mt-4 grid gap-2 text-xs">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">First use</dt>
                    <dd className="m-0 text-right text-foreground">
                      {format(stamp.firstSeenAt)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Last use</dt>
                    <dd className="m-0 text-right text-foreground">
                      {format(stamp.lastSeenAt)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Recorded calls</dt>
                    <dd className="m-0 text-right text-foreground">
                      {stamp.recordedCalls.toLocaleString("en-US")}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section id="agent-activity" className="scroll-mt-40 grid gap-4 rounded-xl border border-border bg-card p-4 sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="m-0 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Append-only audit
            </p>
            <h2 className="mt-2 text-lg font-bold">Recent recorded verdicts</h2>
          </div>
          <span
            className={`w-fit rounded-full border px-2.5 py-1 text-xs font-bold uppercase ${lifecycleClasses(
              passport.agent.status
            )}`}
          >
            Registry · {cleanedText(passport.agent.status, 24)}
          </span>
        </div>
        {passport.recentVerdicts.length === 0 ? (
          <p className="m-0 rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">
            No recorded verdicts. Rate-limit and malformed-request rejections may occur before
            an agent audit row exists.
          </p>
        ) : (
          <ol className="m-0 grid list-none gap-2 p-0">
            {passport.recentVerdicts.map((entry) => (
              <li
                key={entry.id}
                className="grid min-w-0 gap-2 rounded-lg border border-border bg-secondary/30 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <p className="m-0 break-words text-sm font-semibold text-foreground">
                    {cleanedText(entry.provider ?? "gateway", 40)}
                    {entry.model ? ` · ${cleanedText(entry.model, 100)}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {format(entry.createdAt)}
                  </p>
                </div>
                <span
                  className={`w-fit rounded-full border px-2.5 py-1 text-xs font-bold ${verdictClasses(
                    entry.status
                  )}`}
                >
                  {verdictLabel(entry.status)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
