import { describe, expect, it } from "vitest";
import { curated, source } from "./support/curated-source";

// Self-host is one developer on localhost (owner, 2026-10-05). A public profile
// at /@handle, a per-agent public listing and owner binding (prove a domain or
// GitHub account for the public verify page) all exist to be seen by strangers,
// and on localhost there are none. The mirror drops their UI; these read each
// file the way scripts/curate-public.sh publishes it.

describe("self-host has no public profile", () => {
  it("drops the profile section and its nav from Settings", () => {
    const settings = curated("app/dashboard/settings/page.tsx");
    expect(settings).not.toContain("ProfileSettings");
    expect(settings).not.toContain('id="profile"');
    expect(settings).not.toContain('href="#profile"');
  });

  it("drops the per-agent public listing from the agent page and the fleet", () => {
    const agent = curated("app/dashboard/agents/[id]/page.tsx");
    expect(agent).not.toContain("AgentPublicListing");
    expect(agent).not.toContain("agent-public");
    const fleet = curated("components/AgentFleetTable.tsx");
    expect(fleet).not.toContain("publicListing");
    expect(fleet).not.toContain("agent-public");
  });

  it("gives the account menu no Profile item and the card no handle prompt", () => {
    const menu = curated("components/dashboard/SidebarAccountMenu.tsx");
    expect(menu).not.toContain("/dashboard/settings#profile");
    const shell = curated("components/dashboard/DashboardShell.tsx");
    expect(shell).not.toContain("Set a handle");
    expect(shell).not.toContain("/avatars/");
  });
});

describe("self-host has no owner binding", () => {
  it("drops the ownership section, its nav and its status chip from Settings", () => {
    const settings = curated("app/dashboard/settings/page.tsx");
    expect(settings).not.toContain("OwnerBinding");
    expect(settings).not.toContain("readOwner");
    expect(settings).not.toContain('id="ownership"');
    expect(settings).not.toContain('href="#ownership"');
    expect(settings).not.toContain("public ownership");
  });

  it("keeps the gateway's owner reader, which receipts still call", () => {
    for (const path of [
      "app/api/v1/[provider]/[...path]/route.ts",
      "app/api/v1/svc/[service]/[...path]/route.ts",
      "app/api/auth/agent-token/route.ts",
    ]) {
      expect(curated(path), path).toContain('from "@/lib/owner/current"');
    }
  });
});
