"use client";
// Who the operator is, and how much of it a stranger gets to see.
//
// The wording here is the security control, exactly as it is in OwnerBinding.
// Three rules this component exists to hold:
//
//  * PUBLISHING THE PROFILE PUBLISHES NO AGENT. They are two independent
//    opt-ins in the schema (users.profile_public and agents.published), and a
//    UI that implies otherwise would turn one click into a disclosure the
//    operator did not make. It is stated at the control, not in documentation.
//
//  * A RELEASED HANDLE IS GONE FOREVER. 0033 retires it rather than recycling
//    it, so an old /@handle link 404s instead of resolving to somebody else.
//    That is a permanent, irreversible act on a global namespace, so it gets
//    its own form, its own button, and a sentence saying so — not a field in a
//    row of fields that saves with everything else.
//
//  * AND AFTER THE FIRST PUBLISH IT CANNOT MOVE AT ALL (0034). The form stops
//    being a form and becomes a statement of fact. It is shown rather than
//    hidden, because "where is my handle field" is a worse question than "why
//    is this greyed out" — and the answer is written next to it.
//
//  * GOING PRIVATE REVOKES THE AVATAR LINK. setProfilePublic rotates the key,
//    which breaks every URL anyone already has. That is a good thing and it is
//    surprising, so it is said out loud rather than discovered.
//
// Three separate forms rather than one, because each maps to a different server
// action with different consequences. One "Save" button covering all of them
// would make the handle change and the publish toggle feel like edits.
import { useState, useTransition } from "react";
import { Check, Eye, EyeOff, Globe, Lock, TriangleAlert, UserRound } from "lucide-react";

import {
  changeHandle,
  publishProfile,
  saveProfile,
  type ProfileActionState,
} from "@/app/dashboard/settings/profile-actions";
import type { ProfileRecord } from "@/lib/profile/manage";
import { AvatarUploader } from "@/components/AvatarUploader";

function profilePlaceholders() {
  return {
    displayName: "Example Ops",
    company: "Example Company",
    website: "example.com",
  };
}

const PROFILE_PLACEHOLDERS = profilePlaceholders();

export function ProfileSettings({
  profile,
  publishedAgentCount,
}: {
  profile: ProfileRecord | null;
  publishedAgentCount: number;
}) {
  const [state, setState] = useState<ProfileActionState>({ profile });
  const [pending, start] = useTransition();

  const current = state.profile ?? null;
  const [displayName, setDisplayName] = useState(current?.display_name ?? "");
  const [bio, setBio] = useState(current?.bio ?? "");
  const [company, setCompany] = useState(current?.company ?? "");
  const [website, setWebsite] = useState(current?.website_url ?? "");
  const [handle, setHandle] = useState(current?.username ?? "");

  const run = (action: () => Promise<ProfileActionState>) =>
    start(async () => {
      const next = await action();
      // Keep the last known profile when an action only reports an error, so a
      // failed save does not blank the panel the operator is reading.
      setState((previous) => ({ ...next, profile: next.profile ?? previous.profile }));
    });

  const isPublic = current?.profile_public === true;
  const claimedHandle = current?.username ?? null;
  const lockedAt = current?.handle_locked_at ?? null;
  const handleLocked = Boolean(lockedAt);

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

      <AvatarUploader
        avatarKey={current?.avatar_key ?? null}
        hasAvatar={Boolean(current?.avatar_path)}
        displayName={current?.display_name ?? null}
        handle={claimedHandle}
        onResult={(next) =>
          setState((previous) => ({ ...next, profile: next.profile ?? previous.profile }))
        }
      />

      {/* ── The handle. Its own form, because releasing one is permanent. ── */}
      <form
        className="pc-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          run(() => changeHandle(handle));
        }}
      >
        <label className="pc-field">
          <span>Handle</span>
          <div className="pc-profile-handle-input" data-state={handleLocked ? "locked" : "editable"}>
            <span aria-hidden="true">@</span>
            <input
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              placeholder="vertias_ops"
              autoComplete="off"
              spellCheck={false}
              maxLength={30}
              readOnly={handleLocked}
              aria-describedby="profile-handle-note"
            />
            {handleLocked && <Lock aria-hidden="true" />}
          </div>
          <small id="profile-handle-note" className="pc-field-note">
            {handleLocked ? (
              <>
                Permanent. Your handle became fixed the first time you published your profile,
                because from that moment other people may have linked to{" "}
                <code>/@{claimedHandle}</code>. Making the profile private again does not release
                it.
              </>
            ) : (
              <>
                3–30 characters: lowercase letters, numbers and underscores. This is the address
                of your public page, <code>/@{handle.trim().toLowerCase() || "handle"}</code>.
              </>
            )}
          </small>
        </label>

        {!handleLocked && claimedHandle && handle.trim().toLowerCase() !== claimedHandle && (
          <p className="pc-inline-notice is-warning">
            <TriangleAlert aria-hidden="true" />
            <span>
              Changing your handle retires <code>@{claimedHandle}</code> permanently. Nobody can
              claim it afterwards — including you — so an old link to it will stop working rather
              than start pointing at somebody else.
            </span>
          </p>
        )}

        {!handleLocked && (
          <div className="pc-settings-form__actions">
            <span>
              <UserRound aria-hidden="true" />
              {claimedHandle ? `Currently @${claimedHandle}` : "No handle yet"}
            </span>
            <button type="submit" disabled={pending || !handle.trim()}>
              {claimedHandle ? "Change handle" : "Claim handle"}
            </button>
          </div>
        )}
      </form>

      {/* ── The rest of the profile. Ordinary, reversible edits. ── */}
      <form
        className="pc-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          run(() =>
            saveProfile({
              display_name: displayName,
              bio,
              company,
              website_url: website,
            })
          );
        }}
      >
        <div className="pc-settings-form__row">
          <label className="pc-field">
            <span>Display name</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={PROFILE_PLACEHOLDERS.displayName}
              maxLength={60}
              autoComplete="off"
            />
          </label>
          <label className="pc-field">
            <span>Company</span>
            <input
              value={company}
              onChange={(event) => setCompany(event.target.value)}
              placeholder={PROFILE_PLACEHOLDERS.company}
              maxLength={80}
              autoComplete="off"
            />
          </label>
        </div>

        <label className="pc-field">
          <span>Website</span>
          <input
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
            placeholder={PROFILE_PLACEHOLDERS.website}
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
          />
          <small className="pc-field-note">
            A plain <code>https://</code> address. Shown on your public page as a link nobody
            can follow back to us — it carries <code>nofollow</code> and <code>noreferrer</code>.
          </small>
        </label>

        <label className="pc-field">
          <span>Bio</span>
          <textarea
            value={bio}
            onChange={(event) => setBio(event.target.value)}
            rows={3}
            maxLength={280}
            placeholder="What your agents do."
          />
          <small className="pc-field-note">{bio.trim().length}/280</small>
        </label>

        <div className="pc-settings-form__actions">
          <span>
            <Globe aria-hidden="true" />
            These appear on your public page only while it is published.
          </span>
          <button type="submit" disabled={pending}>
            Save profile
          </button>
        </div>
      </form>

      {/* ── The disclosure switch. Separate, and it says what it does. ── */}
      <div className="pc-profile-publish" data-state={isPublic ? "public" : "private"}>
        {isPublic ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
        <div>
          <strong>{isPublic ? "Your profile is public" : "Your profile is private"}</strong>
          {isPublic ? (
            <p>
              Anyone can read <code>/@{claimedHandle}</code>. It shows your name, bio, company,
              link, verified owner and the agents you published — {publishedAgentCount === 0
                ? "and you have published none, so it lists no agents at all."
                : `${publishedAgentCount} of them right now.`}
            </p>
          ) : (
            <>
              <p>
                Nothing about you is readable at <code>/@{claimedHandle ?? "handle"}</code>.
                Making it public publishes the profile and <strong>no agent</strong> — each agent
                is a separate opt-in on its own page.
              </p>
              {claimedHandle && !handleLocked && (
                <p className="pc-field-note is-warning">
                  Publishing also makes <code>@{claimedHandle}</code> permanent. Change it now if
                  it is not the name you want — afterwards it cannot move, because people will be
                  able to link to it.
                </p>
              )}
            </>
          )}
          {isPublic && (
            <p className="pc-field-note is-warning">
              Making it private again also breaks the link to your avatar, so a copy anyone saved
              stops loading.
            </p>
          )}
        </div>
        <button
          type="button"
          disabled={pending || (!isPublic && !claimedHandle)}
          onClick={() => run(() => publishProfile(!isPublic))}
        >
          {isPublic ? "Make private" : "Publish profile"}
        </button>
      </div>
    </div>
  );
}
