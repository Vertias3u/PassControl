import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  activationDiagnosis,
  authenticationProofLabel,
  deriveFirstCallActivation,
  type FirstCallRow,
} from "@/lib/first-call-activation";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const row = (status: FirstCallRow["status"], model = "gpt-5-mini"): FirstCallRow => ({
  id: `log-${status}`,
  agent_id: "agent-1",
  provider: "openai",
  model,
  status,
  receipt: status === "ok" ? "signed-receipt" : null,
  created_at: "2026-08-12T12:00:00.000Z",
});

describe("first-call activation state", () => {
  it("keeps provider setup, agent creation and call proof as separate states", () => {
    expect(deriveFirstCallActivation({ providerConfigured: false, agents: [], logs: [] }).stage)
      .toBe("provider");
    expect(deriveFirstCallActivation({ providerConfigured: true, agents: [], logs: [] }).stage)
      .toBe("agent");
    expect(deriveFirstCallActivation({
      providerConfigured: true,
      agents: [{ id: "agent-1", name: "Scout", status: "active" }],
      logs: [],
    }).stage).toBe("call");
  });

  it("treats only a stored ok row as first-call completion", () => {
    expect(deriveFirstCallActivation({
      providerConfigured: true,
      agents: [{ id: "agent-1", name: "Scout", status: "active" }],
      logs: [row("blocked_scope")],
    }).stage).toBe("diagnose");
    expect(deriveFirstCallActivation({
      providerConfigured: true,
      agents: [{ id: "agent-1", name: "Scout", status: "active" }],
      logs: [row("ok")],
    })).toMatchObject({ stage: "complete", agentId: "agent-1", receiptRecorded: true });
  });

  it("keeps a suspended identity in the flow so its refusal can be diagnosed", () => {
    expect(deriveFirstCallActivation({
      providerConfigured: true,
      agents: [{ id: "agent-1", name: "Scout", status: "suspended" }],
      logs: [row("blocked_suspended")],
    })).toMatchObject({ stage: "diagnose", agentId: "agent-1" });
  });

  it("never presents a refusal, upstream failure or missing receipt as verified success", () => {
    for (const status of [
      "blocked_scope",
      "blocked_policy",
      "blocked_budget",
      "blocked_killed",
      "blocked_suspended",
      "blocked_endpoint",
      "provider_exhausted",
      "no_provider_key",
      "upstream_error",
    ] as const) {
      expect(deriveFirstCallActivation({
        providerConfigured: true,
        agents: [{ id: "agent-1", name: "Scout", status: "active" }],
        logs: [row(status)],
      }).stage).toBe("diagnose");
    }
    expect(deriveFirstCallActivation({
      providerConfigured: true,
      agents: [{ id: "agent-1", name: "Scout", status: "active" }],
      logs: [{ ...row("ok"), receipt: null }],
    })).toMatchObject({ stage: "complete", receiptRecorded: false });
  });
});

// ── Authentication evidence: what the stored row actually proves ─────────────
//
// A passport-mode provider call carries NO fresh Ed25519 signature. It presents a
// reusable, short-lived HS256 bearer visa, and `verifyVisa` is the whole of the
// check. The private key signed a *challenge* earlier, at mint time. So the row
// proves "a passport-derived visa authenticated this call" — it does not prove
// that the private key signed this particular provider request, and a reused or
// stolen still-valid visa is exactly the case that makes the difference visible.
//
// These assertions are about the vocabulary, not about one literal: the passport
// branch must not reach for signature language at all, whatever phrasing a future
// edit prefers.
describe("first-call failure language", () => {
  it("distinguishes Passport, Direct Agent Key and legacy authentication evidence", () => {
    expect(authenticationProofLabel("passport")).toBe("Passport visa accepted");
    expect(authenticationProofLabel("direct_key")).toBe("Direct Agent Key accepted");
    expect(authenticationProofLabel(null)).toContain("not recorded");
  });

  it("never attributes a per-call passport signature to a passport-mode call", () => {
    const passport = authenticationProofLabel("passport");
    expect(passport).toMatch(/visa/i);
    // The claim this exists to prevent. `verifyVisa` checks an HS256 bearer token;
    // nothing on the provider path verifies an Ed25519 signature.
    expect(passport).not.toMatch(/signature|signed|signing/i);
    expect(passport).not.toMatch(/private key|proof of possession/i);
  });

  it("keeps the Direct Agent Key label free of passport language", () => {
    // Trust boundary 1: a direct call is lower-assurance bearer possession and
    // must never borrow passport wording — including the corrected visa wording,
    // since a Direct Agent Key never mints or presents a visa.
    const direct = authenticationProofLabel("direct_key");
    expect(direct).toBe("Direct Agent Key accepted");
    expect(direct).not.toMatch(/passport|visa|signature|signed/i);
  });

  it("leaves an unrecorded authentication method explicitly unknown", () => {
    // A legacy row predates the column. Guessing either credential class here
    // would manufacture evidence, so the fallback names neither.
    for (const legacy of [null, undefined] as const) {
      const label = authenticationProofLabel(legacy);
      expect(label).toContain("not recorded");
      expect(label).not.toMatch(/passport|visa|direct agent key/i);
    }
  });

  // The label is only honest because of what the gateway actually does. Pinned
  // structurally rather than by copying the source: if per-call passport signing
  // were ever moved into the proxy, this goes red — and at that point the old
  // "signature accepted" wording would become correct and should be revisited.
  it("ties the passport-mode label to the real verifyVisa path", () => {
    const challenge = read("app/api/auth/challenge/route.ts");
    const proxy = read("app/api/v1/[provider]/[...path]/route.ts");

    // The Ed25519 signature check lives at the challenge/mint boundary only.
    expect(challenge).toContain("verifySignature(");
    expect(challenge).toContain("mintVisa(");

    // The provider path authenticates a passport principal with verifyVisa and
    // performs no signature verification of its own.
    expect(proxy).toContain("const claims = await verifyVisa(credential.token);");
    expect(proxy).not.toMatch(/verifySignature|ed25519/i);
  });

  // One canonical phrase, one implementation. The completion panel used to repeat
  // the literal, which is how the two surfaces drifted apart in the first place.
  it("renders the shared helper on the passport completion panel", () => {
    const store = read("components/PassportStoreAndConnect.tsx");
    expect(store).toContain("authenticationProofLabel");
    expect(store).not.toContain("Passport signature accepted");
    // The panel's machine-readable state is as much a claim as its copy, and it
    // is what a DOM-level assertion would read. It must not outlive the wording
    // it was named after.
    expect(store).toContain('"passport-visa-ok"');
    expect(store).not.toMatch(/"passport-ok"/);
  });

  // Two dashboard surfaces, one row: they must not disagree about how strong the
  // evidence is. The graph already said "Passport visa"; the guide now agrees.
  it("agrees with the Control Graph about what a passport row proves", () => {
    const graph = read("components/dashboard/ControlGraph.tsx");
    expect(graph).toContain('"Passport visa"');
    expect(graph).not.toMatch(/passport signature|passport signed/i);
    expect(authenticationProofLabel("passport")).toContain("Passport visa");
  });

  it("separates PassControl budget, provider credit and missing provider-key failures", () => {
    expect(activationDiagnosis(row("blocked_budget")).title).toContain("PassControl budget");
    expect(activationDiagnosis(row("provider_exhausted")).title).toContain("Provider credit");
    expect(activationDiagnosis(row("no_provider_key")).title).toContain("provider key");
  });

  it("recognises wildcard model names as configuration values, not callable models", () => {
    const diagnosis = activationDiagnosis(row("upstream_error", "gpt-*"));
    expect(diagnosis.title).toContain("concrete model");
    expect(diagnosis.detail).toContain("authorization pattern");
  });
});

describe("first-call dashboard integration", () => {
  it("reuses the bounded dashboard log scan and listens for stored rows", () => {
    const page = read("app/dashboard/page.tsx");
    const component = read("components/dashboard/FirstCallActivation.tsx");
    expect(page).toContain("<FirstCallActivation");
    expect(page.match(/from\("agent_logs"\)/g) ?? []).toHaveLength(1);
    expect(component).toContain('table: "agent_logs"');
    expect(component).toContain("user_id=eq.${userId}");
    expect(component).toContain("pc-first-call--proof");
    expect(component).toContain("authenticationProofLabel");
    expect(component).toContain("not receipt-verified");
    expect(component).toContain('aria-live="polite"');
    expect(page).toMatch(/select\("provider", \{ count: "exact" \}\)[\s\S]{0,100}limit\(6\)/);
    expect(page).toContain("defaultProvider={firstStoredProvider");
    expect(page).toContain("auth_method: row.auth_method");
  });

  // The guide renders each on-ramp inside a stage branch, so anything that advances
  // the stage unmounts it. A revealed passport secret lives only in that child's
  // React state and cannot be re-fetched — so while a child is showing one, the
  // stage is pinned to the branch that renders it, whatever the server now says.
  // The onramp's own action already defers revalidation; this covers the other
  // direction, a revalidatePath("/") from any unrelated action on the page.
  it("pins the stage while a child is displaying an unrecoverable secret", () => {
    const guide = read("components/dashboard/FirstCallActivation.tsx");
    expect(guide).toMatch(/const \[revealing, setRevealing\] = useState</);
    // Both pinned stages are field-free variants, so the stage name is the whole
    // state — no captured row or agent id can go stale while it is held.
    expect(guide).toMatch(/revealing \? \{ stage: revealing \}/);
    expect(guide.match(/onRevealChange=/g) ?? []).toHaveLength(2);
    for (const child of ["components/KeyImportOnramp.tsx", "components/PassportIssuanceModal.tsx"]) {
      const source = read(child);
      expect(source, child).toMatch(/onRevealChange\?:/);
      // Held through a ref so an inline arrow from the parent cannot re-fire the
      // effect on every render.
      expect(source, child).toMatch(/revealRef/);
    }
  });

  it("keeps reveal-once handling while adding a copyable smoke test", () => {
    const direct = read("components/DirectAgentConnect.tsx");
    const setup = read("lib/direct-connect-config.ts");
    expect(direct).toContain("Copy smoke test");
    expect(direct).toMatch(/preventClose=\{Boolean\(result && !stored\)\}/);
    expect(setup).toContain("smokeCommand");
    expect(setup).not.toContain("model: gpt-*");
  });
});
