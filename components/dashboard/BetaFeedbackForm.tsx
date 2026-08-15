"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { saveBetaFeedback } from "@/app/dashboard/feedback/actions";

function Submit() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending}>{pending ? "Saving…" : "Save feedback"}</button>;
}

export function BetaFeedbackForm({
  initial,
}: {
  initial: { setup_rating: number; feedback: string; contact_permitted: boolean } | null;
}) {
  const [state, action] = useActionState(saveBetaFeedback, undefined);
  return (
    <form action={action} className="pc-settings-form pc-beta-feedback">
      <fieldset>
        <legend>How difficult was the first-call setup?</legend>
        <div className="pc-beta-feedback__rating">
          {[1, 2, 3, 4, 5].map((rating) => <label key={rating}><input type="radio" name="setup_rating" value={rating} defaultChecked={initial?.setup_rating === rating} required /><span>{rating}</span></label>)}
        </div>
        <small>1 = could not finish without help · 5 = clear and independent</small>
      </fieldset>
      <label className="grid gap-2 text-sm">
        <span>What slowed you down, surprised you, or should change?</span>
        <textarea name="feedback" minLength={10} maxLength={2000} rows={7} required defaultValue={initial?.feedback ?? ""} />
        <small>Do not include provider keys, agent credentials, prompts, model responses, or recovery codes.</small>
      </label>
      <label className="flex items-start gap-2 text-sm"><input className="mt-1 w-auto" type="checkbox" name="contact_permitted" defaultChecked={initial?.contact_permitted ?? false} /><span>Vertias may contact me about this feedback.</span></label>
      {state ? <p className={`pc-inline-notice ${state.ok ? "is-success" : "is-danger"}`} role={state.ok ? "status" : "alert"}>{state.message}</p> : null}
      <Submit />
    </form>
  );
}
