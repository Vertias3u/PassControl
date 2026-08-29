"use client";

// The approval form for `passcontrol login`.
//
// It reads the code from ONE place: a field the operator types or pastes into.
// Not from location.hash, not from location.search, not from searchParams. That
// restriction is the security property of the whole flow, not a styling choice —
// see app/dashboard/cli/page.tsx for the takeover it prevents, and
// tests/cli-login-shape.test.ts for the guard that keeps it true.
//
// `data-state` on each panel is deliberate: CLAUDE.md records a receipt page
// that displayed "Signature matches ✓" for a FORGED receipt while the whole
// suite was green, because nothing asserted on what actually rendered. A stage
// that is readable from the DOM is a stage that can be checked.
import { useState, useTransition } from "react";
import { KeyRound, ShieldAlert } from "lucide-react";
import { approveCliDevice, denyCliDevice, inspectCliDevice } from "@/app/dashboard/actions";

type Stage =
  | { kind: "entry" }
  | { kind: "confirm"; code: string; clientName: string; ip: string; requestedAt: string }
  | { kind: "done"; clientName: string }
  | { kind: "denied" };

export function CliDeviceApproval() {
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "entry" });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(work: () => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try {
        await work();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      }
    });
  }

  if (stage.kind === "done") {
    return (
      <div className="pc-settings-manager" data-state="approved">
        <div className="pc-settings-form">
          <h3 className="m-0">Approved</h3>
          <p className="muted">
            <strong className="text-foreground">{stage.clientName}</strong> now holds a
            control-plane key. Your terminal should have continued on its own.
          </p>
          <p className="pc-field-note">
            It is listed in <a href="/dashboard/settings">Settings</a> as{" "}
            <span className="mono">CLI on {stage.clientName}</span>. Revoke it there at any time —
            revocation is immediate, and it is the only stop a control-plane key has.
          </p>
        </div>
      </div>
    );
  }

  if (stage.kind === "denied") {
    return (
      <div className="pc-settings-manager" data-state="denied">
        <div className="pc-settings-form">
          <h3 className="m-0">Refused</h3>
          <p className="muted">Nothing was created. The terminal that asked has been told to stop.</p>
        </div>
      </div>
    );
  }

  if (stage.kind === "confirm") {
    return (
      <div className="pc-settings-manager" data-state="confirm">
        <div className="pc-settings-form">
          <h3 className="m-0">Approve this device?</h3>

          <div className="pc-field">
            <span>Device</span>
            <span data-field="clientName">{stage.clientName}</span>
          </div>
          <div className="pc-field">
            <span>Requested from</span>
            <span className="mono" data-field="ip">
              {stage.ip}
            </span>
          </div>
          <div className="pc-field">
            <span>Code</span>
            <span className="mono" data-field="code">
              {stage.code}
            </span>
          </div>

          {/* Said plainly. "Allow access" would understate it by a lot. */}
          <div className="pc-secret-warning">
            <ShieldAlert className="h-5 w-5 text-destructive" aria-hidden />
            <div>
              <strong>Check this code matches your terminal.</strong> Approving mints a
              write-scoped control-plane key: it can create and revoke agents, rotate passports,
              change budgets and scopes, and arm the kill switch. It is valid until you revoke it.
              If you did not just run <span className="mono">passcontrol login</span>, refuse this.
            </div>
          </div>

          {error ? (
            <p className="pc-form-error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="pc-dialog__actions pc-dialog__actions--spread">
            <button
              type="button"
              className="ghost"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  await denyCliDevice(stage.code);
                  setStage({ kind: "denied" });
                })
              }
            >
              Refuse
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const result = await approveCliDevice(stage.code);
                  setStage({ kind: "done", clientName: result.clientName });
                })
              }
            >
              <KeyRound className="h-4 w-4" aria-hidden />
              {pending ? "Approving…" : "Approve"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pc-settings-manager" data-state="entry">
      <form
        className="pc-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          run(async () => {
            const found = await inspectCliDevice(code);
            if (!found) {
              setError("That code is not valid, or it has expired. Run passcontrol login again.");
              return;
            }
            setStage({ kind: "confirm", code, ...found });
          });
        }}
      >
        <label className="pc-field" htmlFor="cli-code">
          <span>Code from your terminal</span>
          <input
            id="cli-code"
            name="code"
            className="pc-code-input"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="FKDR-8T2W"
            autoComplete="off"
            spellCheck={false}
            maxLength={12}
            required
          />
        </label>

        {error ? (
          <p className="pc-form-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="pc-dialog__actions">
          <button type="submit" disabled={pending || code.trim().length === 0}>
            {pending ? "Checking…" : "Continue"}
          </button>
        </div>

        <p className="pc-field-note">
          Codes last 10 minutes. We will never send you a link with the code already filled in — if
          you received one, do not use it.
        </p>
      </form>
    </div>
  );
}
