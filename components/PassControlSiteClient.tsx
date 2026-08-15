"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import styles from "@/app/home.module.css";

const SELF_HOST_COMMANDS = "npm install -g passcontrol\npasscontrol setup";

export function SelfHostCommands() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(SELF_HOST_COMMANDS);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = SELF_HOST_COMMANDS;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={styles.commandBlock}>
      <pre><code><span>npm install -g passcontrol</span>{"\n"}<span>passcontrol setup</span></code></pre>
      <button type="button" onClick={copy} aria-label="Copy self-host commands">
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

type DemoState = "idle" | "running" | "ok" | "blocked" | "error";

interface RunResponse {
  ok?: boolean;
  blocked?: boolean;
  response?: string;
  error?: string;
}

function DemoBoundaryGraph({ state }: { state: DemoState }) {
  const passed = state === "ok";
  const blocked = state === "blocked";
  const active = state === "running" || passed || blocked;
  return (
    <div className={styles.demoGraph} data-state={state}>
      <div className={styles.demoGraphCopy}>
        <span>Watch control happen.</span>
        <small>Every signal below comes from the call you just made.</small>
      </div>
      <svg viewBox="0 0 620 150" role="img" aria-label={passed ? "Demo call passed PassControl and reached the simulated provider" : blocked ? "Demo call stopped at PassControl" : state === "running" ? "Demo call is approaching PassControl" : state === "error" ? "Demo call outcome was unavailable" : "Demo control path is waiting for a call"}>
        <line className={styles.demoGraphLine} data-active={active} x1="78" y1="68" x2="250" y2="68" />
        <line className={styles.demoGraphLine} data-active={passed} x1="300" y1="68" x2="448" y2="68" />
        <line className={styles.demoGraphLine} data-active={passed} x1="492" y1="68" x2="566" y2="68" />
        {state === "running" ? <circle className={styles.demoGraphPulse} r="5" cx="78" cy="68"><animate attributeName="cx" from="78" to="250" dur="1s" repeatCount="indefinite" /></circle> : null}
        <g className={styles.demoGraphNode} data-active={active}><circle cx="56" cy="68" r="22" /><text x="56" y="112" textAnchor="middle">demo agent</text></g>
        <g className={styles.demoGraphNode} data-active={active} data-blocked={blocked}><circle cx="275" cy="68" r="28" /><text x="275" y="118" textAnchor="middle">PassControl</text></g>
        <g className={styles.demoGraphNode} data-active={passed}><circle cx="470" cy="68" r="22" /><text x="470" y="112" textAnchor="middle">demo provider</text></g>
        <g className={styles.demoGraphNode} data-active={passed}><circle cx="588" cy="68" r="16" /><text x="588" y="108" textAnchor="middle">result</text></g>
      </svg>
      <div className={styles.demoGraphVerdict}>
        <span data-active={passed}>identity {passed ? "verified" : "·"}</span>
        <span data-active={passed}>scope {passed ? "allowed" : "·"}</span>
        <span data-active={passed}>budget {passed ? "reserved" : "·"}</span>
        <span data-blocked={blocked}>kill {blocked ? "blocked" : "·"}</span>
      </div>
    </div>
  );
}

export function DemoConsole() {
  const [prompt, setPrompt] = useState("Say hello in 3 words");
  const [armed, setArmed] = useState(false);
  const [state, setState] = useState<DemoState>("idle");
  const [result, setResult] = useState("Ready. Run a call to see the gate decide.");
  const [running, setRunning] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchMessage, setSwitchMessage] = useState("Demo tenant accepting requests");
  // The server expires the shared anonymous demo flag. Mirror that expiry so
  // the control never claims the tenant is blocked after the gateway restored it.
  const expiryTimer = useRef<number | null>(null);

  function clearExpiry() {
    if (expiryTimer.current !== null) {
      window.clearTimeout(expiryTimer.current);
      expiryTimer.current = null;
    }
  }

  useEffect(() => clearExpiry, []);

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt.trim() || running) return;
    setRunning(true);
    setState("running");
    setResult("Checking identity → scope → budget → kill state…");

    try {
      const response = await fetch("/api/demo/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });
      const data = (await response.json().catch(() => ({}))) as RunResponse;

      if (response.status === 403 && data.blocked) {
        setState("blocked");
        setResult(data.response || "blocked (403)");
      } else if (response.ok && data.ok && typeof data.response === "string") {
        setState("ok");
        setResult(data.response);
      } else {
        setState("error");
        setResult(
          data.response ||
            (response.status === 429
              ? "Rate limited. Wait a moment, then try again."
              : "The demo is temporarily unavailable.")
        );
      }
    } catch {
      setState("error");
      setResult("The demo is temporarily unavailable.");
    } finally {
      setRunning(false);
    }
  }

  async function toggleKill() {
    if (switching) return;
    const next = !armed;
    setSwitching(true);
    setSwitchMessage(next ? "Blocking the demo tenant…" : "Restoring the demo tenant…");

    try {
      const response = await fetch("/api/demo/kill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ armed: next }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        armed?: boolean;
        expires_in?: number;
      };
      if (!response.ok || !data.ok || data.armed !== next) throw new Error("toggle failed");
      setArmed(next);
      clearExpiry();

      if (next && typeof data.expires_in === "number" && data.expires_in > 0) {
        setSwitchMessage(`Blocked at the gateway — restores in ${data.expires_in}s`);
        expiryTimer.current = window.setTimeout(() => {
          expiryTimer.current = null;
          setArmed(false);
          setSwitchMessage("Demo tenant restored — block it again to retry");
        }, data.expires_in * 1_000);
      } else {
        setSwitchMessage(next ? "Blocked at the gateway" : "Demo tenant accepting requests");
      }
    } catch {
      setSwitchMessage("Switch unavailable — no state changed");
    } finally {
      setSwitching(false);
    }
  }

  const status = {
    idle: "standby",
    running: "checking…",
    ok: "200 / allowed",
    blocked: "403 / blocked",
    error: "request failed",
  }[state];

  return (
    <div className={styles.demoConsole} data-state={state} aria-busy={running}>
      <div className={styles.demoToolbar}>
        <div><span className={styles.statusDot} aria-hidden="true" /> passcontrol / control path</div>
        <span>Live boundary</span>
      </div>

      <div className={styles.demoGrid}>
        <div className={styles.demoControls}>
          <form onSubmit={run}>
            <label htmlFor="demo-prompt">Agent message</label>
            <textarea
              id="demo-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              maxLength={500}
              autoComplete="off"
              disabled={running}
              rows={3}
            />
            <button type="submit" disabled={running || !prompt.trim()}>
              {running ? "Checking call…" : "Run governed call"}
            </button>
          </form>

          <div className={styles.killControl} data-armed={armed}>
            <div>
              <span>Demo tenant kill switch</span>
              <strong>{armed ? "BLOCKED" : "ACCEPTING CALLS"}</strong>
              <small>{switchMessage}</small>
            </div>
            <button
              className={styles.killSwitch}
              type="button"
              role="switch"
              aria-checked={armed}
              aria-label={armed ? "Restore demo tenant" : "Block demo tenant"}
              onClick={toggleKill}
              disabled={switching}
            >
              <span />
            </button>
          </div>

          <p className={styles.demoInstruction}>
            Run once. Block the tenant. Run the same call again.
          </p>
        </div>

        <div className={styles.demoOutput} aria-live="polite" aria-atomic="true">
          <div className={styles.outputHeader}>
            <span>Gateway result</span>
            <strong>{status}</strong>
          </div>
          <DemoBoundaryGraph state={state} />
          <div className={styles.outputBody}>
            <span>response</span>
            <p>{result}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CurrentYear() {
  return <span suppressHydrationWarning>{new Date().getFullYear()}</span>;
}
