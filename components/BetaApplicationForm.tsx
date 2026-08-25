"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { applyForBeta } from "@/app/beta/actions";
import { BETA_PROVIDERS, BETA_PROVIDER_LABELS } from "@/lib/beta-providers";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "Sending application…" : "Request beta access"}
      <ArrowRight aria-hidden="true" />
    </button>
  );
}

export function BetaApplicationForm() {
  const [state, action] = useActionState(applyForBeta, undefined);

  if (state?.status === "success") {
    return (
      <div className="beta-success" role="status" data-beta-application="submitted">
        <CheckCircle2 aria-hidden="true" />
        <div>
          <strong>Application received.</strong>
          <p>{state.message}</p>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="beta-form" data-beta-application="form">
      <label>
        <span>Email</span>
        <input name="email" type="email" autoComplete="email" required maxLength={320} />
      </label>
      <div className="beta-form__pair">
        <label>
          <span>First tool to connect</span>
          <select name="integration" defaultValue="hermes" required>
            <option value="hermes">Hermes Agent</option>
            <option value="openhands">OpenHands</option>
            <option value="open-webui">Open WebUI</option>
            <option value="sdk">My own SDK or agent</option>
            <option value="other">Another tool</option>
          </select>
        </label>
        <label>
          <span>Model provider</span>
          {/* Rendered from BETA_PROVIDERS rather than typed out, because the
              hand-written list here had already fallen behind the accepted set.
              BETA_PROVIDER_LABELS is a total Record, so a new provider cannot
              reach the form without a label. */}
          <select name="provider" defaultValue="undecided" required>
            {[...BETA_PROVIDERS]
              .sort((a, b) => (a === "undecided" ? -1 : b === "undecided" ? 1 : 0))
              .map((provider) => (
                <option key={provider} value={provider}>
                  {BETA_PROVIDER_LABELS[provider]}
                </option>
              ))}
          </select>
        </label>
      </div>
      <label>
        <span>Expected calls each month</span>
        <select name="monthly_call_bucket" defaultValue="unknown" required>
          <option value="unknown">I do not know yet</option>
          <option value="under-1000">Under 1,000</option>
          <option value="1000-5000">1,000–5,000</option>
          <option value="5000-10000">5,000–10,000</option>
          <option value="over-10000">Over 10,000</option>
        </select>
      </label>
      <label>
        <span>What will the agent do?</span>
        <textarea
          name="use_case"
          minLength={20}
          maxLength={1200}
          rows={5}
          required
          placeholder="Describe the agent, where it runs, and what must stay controlled."
        />
        <small>20–1,200 characters. Do not include API keys, prompts, or credentials.</small>
      </label>
      <label className="beta-form__consent">
        <input name="contact_consent" type="checkbox" required />
        <span>Vertias may email me about this application and beta setup.</span>
      </label>
      <label className="beta-form__honeypot" aria-hidden="true">
        Company website
        <input name="company_website" type="text" tabIndex={-1} autoComplete="off" />
      </label>
      {state?.status === "error" ? <p role="alert" className="beta-form__error">{state.message}</p> : null}
      <Submit />
      <p className="beta-form__privacy">
        Applications are reviewed by a human. See the <a href="/legal/privacy">privacy notice</a> for retention and deletion details.
      </p>
    </form>
  );
}
