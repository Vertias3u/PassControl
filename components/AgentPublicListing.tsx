"use client";
// Listing this agent on the operator's public /@handle page.
//
// The only control in the dashboard whose effect is visible to strangers, so
// the wording carries three things the schema cannot:
//
//  * WHY THERE IS A SECOND NAME FIELD. `agents.name` is customer-identifying —
//    0015 refuses it on the public passport surface because `acme-prod-billing`
//    published under a vendor's handle is a customer list. The form says so,
//    because an operator who does not know that will simply retype the name.
//    The label is NOT pre-filled from the name for the same reason: a
//    pre-filled field is a field people accept.
//
//  * THAT THIS IS THE SECOND OF TWO OPT-INS. Publishing an agent shows nobody
//    anything until the profile is public as well. Saying "published" while the
//    page does not exist would be a lie in the reassuring direction, so the
//    state here names whichever half is still missing.
//
//  * WHAT IS ACTUALLY DISCLOSED. Label, passport, status and issue date — and
//    not budget, scopes, policy, or call history. An operator deciding whether
//    to publish needs the list, not a link to documentation.
import { useState, useTransition } from "react";
import { Check, Eye, EyeOff, TriangleAlert } from "lucide-react";

import {
  publishAgent,
  type PublishAgentState,
} from "@/app/dashboard/agents/[id]/publish-actions";
import { PUBLIC_LABEL_MAX_LENGTH } from "@/lib/profile/publish";

export function AgentPublicListing({
  agentId,
  agentName,
  published,
  publicLabel,
  hasPassport,
  profileHandle,
  profilePublic,
}: {
  agentId: string;
  agentName: string;
  published: boolean;
  publicLabel: string | null;
  hasPassport: boolean;
  profileHandle: string | null;
  profilePublic: boolean;
}) {
  const [state, setState] = useState<PublishAgentState>({});
  const [label, setLabel] = useState(publicLabel ?? "");
  const [pending, start] = useTransition();

  const isPublished = state.agent?.published ?? published;
  const live = isPublished && profilePublic && Boolean(profileHandle);
  const sameAsName = label.trim().toLowerCase() === agentName.trim().toLowerCase();

  const run = (input: { published: boolean; label?: string }) =>
    start(async () => setState(await publishAgent(agentId, input)));

  // An agent with no passport cannot be verified, and the whole value of the
  // public list is that every row is independently checkable at /verify. 0033's
  // RPC filters these out, so offering the control would be offering something
  // that silently does nothing.
  if (!hasPassport) {
    return (
      <p className="pc-inline-notice">
        <EyeOff aria-hidden="true" />
        This agent has no passport, so it cannot be listed publicly — a public listing exists to
        be checked at <code>/verify</code>, and there would be nothing to check.
      </p>
    );
  }

  return (
    <div className="pc-settings-manager">
      {state.error && (
        <p className="pc-inline-notice is-danger" role="alert">
          <TriangleAlert aria-hidden="true" /> {state.error}
        </p>
      )}
      {state.notice && !state.error && (
        <p className="pc-inline-notice is-success" role="status">
          <Check aria-hidden="true" /> {state.notice}
        </p>
      )}

      <div className="pc-profile-publish" data-state={live ? "public" : "private"}>
        {live ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
        <div>
          <strong>
            {live
              ? "Listed publicly"
              : isPublished
                ? "Listed, but your profile is not public yet"
                : "Not listed"}
          </strong>
          {live ? (
            <p>
              Anyone reading <code>/@{profileHandle}</code> sees this agent&rsquo;s public name,
              its passport and its status, and can verify it themselves. Its budget, scopes,
              policy and call history stay private.
            </p>
          ) : isPublished ? (
            <p>
              Nothing is visible yet. Listing an agent is one of two opt-ins — publish your
              profile in <a href="/dashboard/settings#profile">Settings</a> and this agent
              appears on it.
            </p>
          ) : (
            <p>
              This agent appears nowhere public. Listing it shows its public name, passport and
              status on your profile page — never its internal name, budget, scopes or calls.
            </p>
          )}
        </div>
      </div>

      {!isPublished ? (
        <form
          className="pc-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            run({ published: true, label });
          }}
        >
          <label className="pc-field">
            <span>Public name</span>
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Research Agent"
              maxLength={PUBLIC_LABEL_MAX_LENGTH}
              autoComplete="off"
            />
            <small className="pc-field-note">
              What strangers see. Deliberately separate from this agent&rsquo;s internal name
              (<code>{agentName}</code>), which is never published — internal names often name
              the customer an agent works for.
            </small>
          </label>

          {sameAsName && label.trim() !== "" && (
            <p className="pc-inline-notice is-warning">
              <TriangleAlert aria-hidden="true" />
              <span>
                That is the internal name. Fine if it gives nothing away — but if it names a
                customer, a project or a client system, publishing it hands that to anyone who
                reads the page.
              </span>
            </p>
          )}

          <div className="pc-settings-form__actions">
            <span>
              <Eye aria-hidden="true" />
              {profilePublic ? "Appears immediately" : "Appears once your profile is public"}
            </span>
            <button type="submit" disabled={pending || !label.trim()}>
              List on my profile
            </button>
          </div>
        </form>
      ) : (
        <div className="pc-settings-form__actions">
          <span>
            <Eye aria-hidden="true" />
            Listed as <strong>{state.agent?.public_label ?? publicLabel}</strong>
          </span>
          <button type="button" disabled={pending} onClick={() => run({ published: false })}>
            Remove from my profile
          </button>
        </div>
      )}
    </div>
  );
}
