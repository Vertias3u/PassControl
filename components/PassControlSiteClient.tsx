"use client";

import { FormEvent, useState } from "react";

const INSTALL_COMMAND = "npm install -g passcontrol";

export function InstallCommand() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(INSTALL_COMMAND);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = INSTALL_COMMAND;
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
    <div className="pc-install">
      <div className="pc-install-label">
        <span>Install PassControl</span>
        <span>npm · BSL-1.1</span>
      </div>
      <div className="pc-install-command">
        <code>{INSTALL_COMMAND}</code>
        <button type="button" onClick={copy} aria-label="Copy npm install command">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
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

export function DemoConsole() {
  const [prompt, setPrompt] = useState("Say hello in 3 words");
  const [armed, setArmed] = useState(false);
  const [state, setState] = useState<DemoState>("idle");
  const [result, setResult] = useState("Ready. The demo passport is held server-side.");
  const [running, setRunning] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchMessage, setSwitchMessage] = useState("Demo tenant accepting requests");

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt.trim() || running) return;
    setRunning(true);
    setState("running");
    setResult("Signing challenge → minting work-visa → entering gateway…");

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
    setSwitchMessage(next ? "Arming demo tenant…" : "Restoring demo tenant…");

    try {
      const response = await fetch("/api/demo/kill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ armed: next }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        armed?: boolean;
      };
      if (!response.ok || !data.ok || data.armed !== next) throw new Error("toggle failed");
      setArmed(next);
      setSwitchMessage(next ? "Demo tenant blocked at the gateway" : "Demo tenant accepting requests");
    } catch {
      setSwitchMessage("Switch unavailable — no state changed");
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className={`pc-demo-console pc-demo-${state}`}>
      <div className="pc-demo-toolbar">
        <div>
          <span className="pc-console-dot" aria-hidden="true" />
          <span>passcontrol / live gateway</span>
        </div>
        <span className="pc-demo-badge">Keyless demo</span>
      </div>

      <div className="pc-demo-grid">
        <div className="pc-demo-controls">
          <form onSubmit={run}>
            <label htmlFor="demo-prompt">Agent message</label>
            <div className="pc-prompt-row">
              <input
                id="demo-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                maxLength={500}
                autoComplete="off"
                disabled={running}
              />
              <button className="pc-run-button" type="submit" disabled={running || !prompt.trim()}>
                {running ? "Governing…" : "Run governed call"}
              </button>
            </div>
          </form>

          <div className={`pc-kill-control ${armed ? "is-armed" : ""}`}>
            <div>
              <span className="pc-field-label">Demo tenant kill switch</span>
              <strong>{armed ? "ARMED" : "DISARMED"}</strong>
              <small>{switchMessage}</small>
            </div>
            <button
              className="pc-switch"
              type="button"
              role="switch"
              aria-checked={armed}
              aria-label="Arm demo tenant kill switch"
              onClick={toggleKill}
              disabled={switching}
            >
              <span />
            </button>
          </div>

          <p className="pc-demo-instruction">
            Run once, arm the switch, then run the same call again. Disarm to restore it.
          </p>
        </div>

        <div className="pc-demo-output" aria-live="polite" aria-atomic="true">
          <div className="pc-output-heading">
            <span>Gateway result</span>
            <strong>
              {state === "ok" && "200 / governed"}
              {state === "blocked" && "403 / blocked"}
              {state === "running" && "policy checks…"}
              {state === "error" && "request failed"}
              {state === "idle" && "standby"}
            </strong>
          </div>
          <div className="pc-output-body">
            <span className="pc-output-prefix">response</span>
            <p>{result}</p>
          </div>
          <div className="pc-governance-readout" aria-label="Governance checks">
            <span className={state === "ok" ? "is-checked" : ""}>visa {state === "ok" ? "✓" : "·"}</span>
            <span className={state === "ok" ? "is-checked" : ""}>scope {state === "ok" ? "✓" : "·"}</span>
            <span className={state === "ok" ? "is-checked" : ""}>budget {state === "ok" ? "✓" : "·"}</span>
            <span className={state === "blocked" ? "is-blocked" : ""}>
              kill switch {state === "blocked" ? "blocked" : "·"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CurrentYear() {
  return <span suppressHydrationWarning>{new Date().getFullYear()}</span>;
}
