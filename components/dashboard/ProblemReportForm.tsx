"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { submitProblemReport } from "@/app/dashboard/report/actions";
import { MESSAGE_MAX, MESSAGE_MIN, type ProblemReportType } from "@/lib/problem-report-kinds";

const KINDS: ReadonlyArray<{ value: ProblemReportType; label: string; hint: string }> = [
  { value: "bug", label: "Something is broken", hint: "It errors, hangs, or does the wrong thing." },
  { value: "confusing", label: "Something is confusing", hint: "It works, but I could not tell what to do." },
  { value: "feature", label: "Something is missing", hint: "I needed a capability that is not here." },
  { value: "security", label: "A security concern", hint: "Read the notice below before using this." },
];

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "Sending…" : "Send report"}
    </button>
  );
}

export function ProblemReportForm({ preview }: { preview: unknown }) {
  const [state, action] = useActionState(submitProblemReport, undefined);
  const [kind, setKind] = useState<ProblemReportType>("bug");
  const [chars, setChars] = useState(0);

  return (
    <form action={action} className="pc-settings-form" data-report-kind={kind}>
      <fieldset>
        <legend>What kind of problem is this?</legend>
        {KINDS.map((option) => (
          <label key={option.value} className="flex items-start gap-2 text-sm">
            <input
              className="mt-1 w-auto"
              type="radio"
              name="kind"
              value={option.value}
              checked={kind === option.value}
              onChange={() => setKind(option.value)}
              required
            />
            <span>
              {option.label}
              <small className="block">{option.hint}</small>
            </span>
          </label>
        ))}
      </fieldset>

      {/*
        SECURITY.md is explicit that GitHub private vulnerability reporting is
        the ONLY channel, and that there is deliberately no security@ mailbox.
        This has to appear BEFORE someone types exploit details into a column
        that operators read in plain text — a notice underneath the textarea
        arrives after the damage.
      */}
      {kind === "security" ? (
        <p className="pc-inline-notice is-danger" role="alert" data-state="security-channel">
          <strong>This form is not a confidential channel.</strong> The text is stored unencrypted and
          operators read it. For a vulnerability, use{" "}
          <a href="https://github.com/Vertias3u/PassControl/security/advisories/new" rel="noreferrer noopener" target="_blank">
            GitHub private vulnerability reporting
          </a>
          , which is private between you and the maintainer. Use this form only for a security
          <em> question</em>, never for an unfixed flaw.
        </p>
      ) : null}

      <label className="grid gap-2 text-sm">
        <span>What happened?</span>
        <textarea
          name="message"
          minLength={MESSAGE_MIN}
          maxLength={MESSAGE_MAX}
          rows={9}
          required
          onChange={(event) => setChars(event.target.value.trim().length)}
          placeholder="What you did, what you expected, what happened instead."
        />
        <small data-state={chars > 0 && chars < MESSAGE_MIN ? "short" : "ok"}>
          {chars.toLocaleString()} / {MESSAGE_MAX.toLocaleString()} characters, {MESSAGE_MIN} minimum.
        </small>
        <small>
          Anything that looks like a key, token or visa is removed from the text before it is stored —
          but do not paste one deliberately.
        </small>
      </label>

      <label className="flex items-start gap-2 text-sm">
        {/* Unchecked by default. Consent is a choice, not a default. */}
        <input className="mt-1 w-auto" type="checkbox" name="attach_diagnostics" />
        <span>
          Attach diagnostics from my workspace
          <small className="block">
            Agent, budget and failure metadata. No prompts, model responses, provider keys,
            credential hashes, recovery codes or session tokens.
          </small>
        </span>
      </label>

      <details className="pc-report-preview">
        <summary>See exactly what would be attached</summary>
        <p>
          <small>
            Rebuilt on the server when you press send, so what arrives may differ by a few minutes of
            activity. Every report also records which build of PassControl you were using; that
            identifier is operator-restricted and is not shown here.
          </small>
        </p>
        <pre>{JSON.stringify(preview, null, 2)}</pre>
      </details>

      {state ? (
        <p className={`pc-inline-notice ${state.ok ? "is-success" : "is-danger"}`} role={state.ok ? "status" : "alert"}>
          {state.message}
        </p>
      ) : null}
      <Submit />
    </form>
  );
}
