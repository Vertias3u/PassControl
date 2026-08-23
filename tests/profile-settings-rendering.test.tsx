// The profile panel, in the DOM rather than in the model.
//
// The wording here IS the security control, the same way it is in OwnerBinding,
// so the assertions are about what an operator actually reads before they click
// something irreversible:
//
//   * That publishing the profile publishes NO agent. Two independent opt-ins
//     is the single most important property of this feature, and the place it
//     gets lost is a sentence, not a query.
//   * That changing a handle retires the old one permanently. The warning has
//     to be on screen at the moment of the change, not in documentation.
//   * That the publish button cannot be pressed without a handle, since a
//     public profile with no address to be public at is a flag that means
//     nothing.
//
// Asserted on markup because `npm test` passing has said nothing about what
// renders before: a receipt page once displayed "Signature matches ✓" against a
// forged receipt with the whole suite green.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/dashboard/settings/profile-actions", () => ({
  saveProfile: async () => ({}),
  changeHandle: async () => ({}),
  publishProfile: async () => ({}),
  uploadAvatar: async () => ({}),
  removeAvatar: async () => ({}),
}));

const { ProfileSettings } = await import("@/components/ProfileSettings");

type Row = Parameters<typeof ProfileSettings>[0]["profile"];

function profile(overrides: Record<string, unknown> = {}): Row {
  return {
    username: "vertiasops",
    display_name: "Vertias Ops",
    bio: null,
    website_url: null,
    company: null,
    timezone: null,
    profile_public: false,
    avatar_path: null,
    avatar_key: null,
    handle_locked_at: null,
    created_at: "2026-01-04T10:00:00.000Z",
    ...overrides,
  } as Row;
}

const html = (row: Row, publishedAgentCount = 0) =>
  renderToStaticMarkup(<ProfileSettings profile={row} publishedAgentCount={publishedAgentCount} />);

describe("the two independent opt-ins", () => {
  // The sentence this whole feature rests on.
  it("says publishing the profile publishes no agent", () => {
    const out = html(profile());
    expect(out).toContain('data-state="private"');
    expect(out).toContain("<strong>no agent</strong>");
    expect(out).toContain("separate opt-in");
  });

  // And once public it must not imply agents came with it.
  it("says explicitly that a public profile with nothing published lists no agents", () => {
    const out = html(profile({ profile_public: true }), 0);
    expect(out).toContain('data-state="public"');
    expect(out).toContain("you have published none");
    expect(out).toContain("lists no agents at all");
  });

  it("reports the real published count when there is one", () => {
    expect(html(profile({ profile_public: true }), 3)).toContain("3 of them right now");
  });
});

describe("handle retirement", () => {
  // The warning is rendered from state the operator has typed, so a static
  // render shows the un-edited case: no warning, because nothing is changing.
  it("does not cry wolf when the handle is untouched", () => {
    expect(html(profile())).not.toContain("permanently");
  });

  it("offers to claim rather than change when there is no handle yet", () => {
    const out = html(profile({ username: null }));
    expect(out).toContain("Claim handle");
    expect(out).toContain("No handle yet");
    expect(out).not.toContain("Change handle");
  });

  it("names the current handle so the operator knows what they are replacing", () => {
    expect(html(profile())).toContain("Currently @vertiasops");
  });
});

describe("the handle lock", () => {
  const locked = () => html(profile({ handle_locked_at: "2026-02-01T00:00:00.000Z", profile_public: true }));

  // Shown rather than hidden. "Where did my handle field go" is a worse
  // question than "why is this greyed out", and the answer sits next to it.
  it("shows the handle as a fact, with no way to submit a change", () => {
    const out = locked();
    expect(out).toContain('data-state="locked"');
    expect(out).toContain("readonly");
    expect(out).not.toContain("Change handle");
    expect(out).toContain("Permanent.");
  });

  it("says WHY it is fixed, and that going private does not release it", () => {
    const out = locked();
    expect(out).toContain("first time you published");
    expect(out).toContain("does not release");
  });

  // The retirement warning belongs to a change that can still happen. Showing
  // it beside a field nobody can edit is noise that trains people to skim.
  it("drops the retirement warning once nothing can be changed", () => {
    expect(locked()).not.toContain("retires");
  });

  it("leaves the field editable while the profile has never been published", () => {
    const out = html(profile());
    expect(out).toContain('data-state="editable"');
    expect(out).toContain("Change handle");
    expect(out).not.toContain("Permanent.");
  });
});

describe("warning before the irreversible half", () => {
  // The lock is a consequence of publishing that nobody would guess, so it is
  // stated at the publish control BEFORE the click, not discovered afterwards.
  it("warns that publishing will make the handle permanent", () => {
    const out = html(profile());
    expect(out).toContain("permanent");
    expect(out).toContain("Change it now");
  });

  it("stops saying so once it already is permanent", () => {
    const out = html(profile({ handle_locked_at: "2026-02-01T00:00:00.000Z" }));
    expect(out).not.toContain("Change it now");
  });

  it("does not warn about a handle that does not exist yet", () => {
    expect(html(profile({ username: null }))).not.toContain("Change it now");
  });
});

describe("the publish control", () => {
  // A public profile with no handle has no address to be public at, so the
  // control is unavailable rather than failing after the click.
  it("cannot be pressed without a handle", () => {
    const out = html(profile({ username: null }));
    expect(out).toMatch(/Publish profile/);
    expect(out).toMatch(/<button[^>]*disabled[^>]*>[^<]*Publish profile/);
  });

  it("is available once a handle exists", () => {
    expect(html(profile())).not.toMatch(/<button[^>]*disabled[^>]*>[^<]*Publish profile/);
  });

  // Rotation on going private is real behaviour in setProfilePublic, and it is
  // surprising, so it has to be said before the click and not discovered after.
  it("warns that going private breaks a shared avatar link", () => {
    const out = html(profile({ profile_public: true, avatar_path: "u/avatar", avatar_key: "k" }));
    expect(out).toContain("breaks the link to your avatar");
  });
});

describe("nothing private leaks into the panel", () => {
  // The panel is the operator's own, so this is not a disclosure boundary — but
  // avatar_path is the storage layout and has no business being rendered
  // anywhere, and the assertion costs nothing.
  it("renders the avatar by key, never by storage path", () => {
    const out = html(profile({ avatar_path: "11111111-1111-1111-1111-111111111111/avatar", avatar_key: "capKey123456789012" }));
    expect(out).toContain("/avatars/capKey123456789012");
    expect(out).not.toContain("11111111-1111-1111-1111-111111111111");
  });

  it("renders initials rather than a broken image when there is no avatar", () => {
    const out = html(profile());
    expect(out).not.toContain("/avatars/");
    expect(out).toContain("VO");
  });
});
