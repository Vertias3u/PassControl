import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const actionBody = (name: string): string => {
  const actions = read("app/dashboard/actions.ts");
  const start = actions.indexOf(`export async function ${name}`);
  const end = actions.indexOf("\n/**", start + 1);
  return actions.slice(start, end === -1 ? undefined : end);
};

describe("Direct Agent browser on-ramp", () => {
  it("ships one provider-native wizard with reveal-once handling", () => {
    const ui = read("components/DirectAgentConnect.tsx");
    expect(ui).toMatch(/issueDirectAgent/);
    expect(ui).toMatch(/buildDirectConnectSetup/);
    expect(ui).toMatch(/Client model/);
    expect(ui).toMatch(/Shown once/i);
    expect(ui).toMatch(/preventClose=\{Boolean\(result && !stored\)\}/);
    expect(ui).toMatch(/I(?:&apos;|')ve stored this credential securely/);
  });

  it("does not revalidate before the Direct Agent Key is committed to browser state", () => {
    const ui = read("components/DirectAgentConnect.tsx");
    expect(actionBody("issueDirectAgent")).not.toMatch(/revalidatePath/);
    expect(ui).toMatch(/useRouter/);
    expect(ui).toMatch(/const acknowledgeStored = \(\) =>/);
    expect(ui).toMatch(/disabled=\{!stored\} onClick=\{acknowledgeStored\}/);
  });

  it("does not pretend configuration proves a provider call succeeded", () => {
    const ui = read("components/DirectAgentConnect.tsx");
    expect(ui).toMatch(/Credential created/);
    expect(ui).toMatch(/not yet proof that traffic reached the gateway/i);
    expect(ui).not.toMatch(/Keyless verified|Provider path verified/);
  });

  it("makes direct connect the primary fleet action without removing passport issuance", () => {
    const page = read("app/dashboard/page.tsx");
    expect(page).toMatch(/<DirectAgentConnect/);
    expect(page).toMatch(/<PassportIssuanceModal/);
  });
});

describe("Provider-key import reveal-once handoff", () => {
  it("refreshes the fleet only after the private passport is acknowledged", () => {
    const ui = read("components/KeyImportOnramp.tsx");
    const store = read("components/PassportStoreAndConnect.tsx");
    expect(ui).toMatch(/useRouter/);
    expect(ui).toMatch(/const acknowledgeStored = \(\) =>/);
    expect(ui).toMatch(/if \(!stored\) return;[\s\S]*reset\(\);[\s\S]*router\.refresh\(\);/);
    expect(ui).toMatch(/onFinish=\{acknowledgeStored\}/);
    expect(store).toMatch(/disabled=\{!stored\} onClick=\{onFinish\}/);
  });

  it("warns before reloads and client-side link navigation while the passport is unacknowledged", () => {
    const store = read("components/PassportStoreAndConnect.tsx");
    expect(store).toMatch(/window\.addEventListener\("beforeunload", warn\)/);
    expect(store).toMatch(/document\.addEventListener\("click", warnBeforeLinkNavigation, true\)/);
    expect(store).toMatch(/Leave before saving the passport\?/);
  });
});

describe("Direct Agent Key management", () => {
  it("lists, creates, reveal-once acknowledges, and revokes installation credentials", () => {
    const panel = read("components/DirectAgentKeyPanel.tsx");
    expect(panel).toMatch(/issueDirectAgentKey/);
    expect(panel).toMatch(/revokeDirectAgentKey/);
    expect(panel).toMatch(/lastUsedAt/);
    expect(panel).toMatch(/recordedCalls/);
    expect(panel).toMatch(/Shown once/i);
    expect(panel).not.toMatch(/last_used_at/);
  });

  it("does not refresh an agent page before a new installation key is stored", () => {
    const panel = read("components/DirectAgentKeyPanel.tsx");
    expect(actionBody("issueDirectAgentKey")).not.toMatch(/revalidatePath/);
    expect(panel).toMatch(/useRouter/);
    expect(panel).toMatch(/const acknowledgeIssued = \(\) =>/);
    expect(panel).toMatch(/disabled=\{!stored\} onClick=\{acknowledgeIssued\}/);
  });

  it("renders direct-only identity without fabricating a passport", () => {
    const passport = read("components/AgentPassport.tsx");
    const page = read("app/dashboard/agents/[id]/page.tsx");
    expect(passport).toMatch(/DirectAgentIdentity/);
    expect(page).toMatch(/passport\.agent\.passportId\s*\?/);
    expect(page).toMatch(/<DirectAgentKeyPanel/);
  });

  it("offers an in-place browser-generated passport upgrade with reveal-once acknowledgement", () => {
    const upgrade = read("components/DirectAgentPassportUpgrade.tsx");
    const actions = read("app/dashboard/actions.ts");
    const actionBody = actions.slice(
      actions.indexOf("export async function attachAgentPassport"),
      actions.indexOf("export async function updateAgent", actions.indexOf("export async function attachAgentPassport"))
    );
    expect(upgrade).toMatch(/attachAgentPassport/);
    expect(upgrade).toMatch(/randomPrivateKey/);
    expect(upgrade).toMatch(/Shown once/i);
    expect(upgrade).toMatch(/Existing Direct Agent Keys keep working until revoked/i);
    expect(upgrade).toMatch(/preventClose=\{Boolean\(secret && !stored\)\}/);
    expect(actionBody).not.toMatch(/revalidatePath/);
  });

  it("makes nullable passport ids safe in the fleet and command palette", () => {
    const fleet = read("components/AgentFleetTable.tsx");
    const commands = read("components/dashboard/DashboardCommandPalette.tsx");
    expect(fleet).toMatch(/passport_pubkey: string \| null/);
    expect(commands).toMatch(/passport_pubkey: string \| null/);
    expect(fleet).toMatch(/Direct Agent Key/);
    expect(commands).toMatch(/direct agent/i);
  });

  it("shows stored direct authentication identity in call history instead of passport placeholders", () => {
    const page = read("app/dashboard/page.tsx");
    const drawer = read("components/dashboard/CallDetailDrawer.tsx");
    expect(page).toMatch(/auth_method, agent_access_key_id, credential_use_id/);
    expect(drawer).toMatch(/Authentication method/);
    expect(drawer).toMatch(/Direct key ID/);
    expect(drawer).toMatch(/Credential use ID/);
  });
});
