import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  activationDiagnosis,
  authenticationProofLabel,
  deriveFirstCallActivation,
  onboardingStateHidden,
  refusalTestModel,
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
  it("hides durable dismissal or completion without storing any step result", () => {
    expect(onboardingStateHidden(null)).toBe(false);
    expect(onboardingStateHidden({ dismissed_at: null, completed_at: null })).toBe(false);
    expect(onboardingStateHidden({ dismissed_at: "2026-08-24T12:00:00.000Z", completed_at: null })).toBe(true);
    expect(onboardingStateHidden({ dismissed_at: null, completed_at: "2026-08-24T12:00:00.000Z" })).toBe(true);
  });

  it("keeps provider setup, agent creation and call proof as separate states", () => {
    expect(deriveFirstCallActivation({ providerConfigured: false, refusalTest: null, agents: [], logs: [] }).stage)
      .toBe("provider");
    expect(deriveFirstCallActivation({ providerConfigured: true, refusalTest: null, agents: [], logs: [] }).stage)
      .toBe("agent");
    expect(deriveFirstCallActivation({
      providerConfigured: true,
      refusalTest: null,
      agents: [{ id: "agent-1", name: "Scout", status: "active" }],
      logs: [],
    }).stage).toBe("call");
  });

  it("treats only a stored ok row as first-call completion", () => {
    expect(deriveFirstCallActivation({
      providerConfigured: true,
      refusalTest: null,
      agents: [{ id: "agent-1", name: "Scout", status: "active" }],
      logs: [row("blocked_scope")],
    }).stage).toBe("diagnose");
    expect(deriveFirstCallActivation({
      providerConfigured: true,
      refusalTest: null,
      agents: [{ id: "agent-1", name: "Scout", status: "active" }],
      logs: [row("ok")],
    })).toMatchObject({ stage: "refuse", agentId: "agent-1", receiptRecorded: true });
  });

  // ── SDK housekeeping must not fire the milestone ──────────────────────────
  //
  // An SDK pointed at PassControl lists models on startup. That row is real,
  // governed and `ok` — and it is a handshake, not a call anyone asked the agent
  // to make. Treating it as first-call completion tells an operator their agent
  // is working before it has ever run a single inference. See lib/call-class.ts.
  const probeRow = (): FirstCallRow => ({
    id: "log-probe",
    agent_id: "agent-1",
    provider: "openai",
    model: "", // GET /v1/models carries no model
    status: "ok",
    receipt: "signed-receipt",
    created_at: "2026-08-12T11:59:00.000Z",
  });

  it("does not complete on a successful capability probe alone", () => {
    const state = deriveFirstCallActivation({
      providerConfigured: true,
      refusalTest: null,
      agents: [{ id: "agent-1", name: "Scout", status: "active" }],
      logs: [probeRow()],
    });
    expect(state.stage).toBe("call");
    // Still worth telling the operator: the SDK reached us, so base URL and
    // credential are right, and only the inference itself is outstanding.
    expect(state).toMatchObject({ stage: "call", connected: true });
  });

  it("reports no connection when nothing at all has arrived", () => {
    expect(deriveFirstCallActivation({
      providerConfigured: true,
      refusalTest: null,
      agents: [{ id: "agent-1", name: "Scout", status: "active" }],
      logs: [],
    })).toMatchObject({ stage: "call", connected: false });
  });

  it("completes on the real call even when a probe arrived first", () => {
    expect(deriveFirstCallActivation({
      providerConfigured: true,
      refusalTest: null,
      agents: [{ id: "agent-1", name: "Scout", status: "active" }],
      logs: [row("ok"), probeRow()],
    })).toMatchObject({ stage: "refuse", agentId: "agent-1" });
  });

  it("diagnoses a real refusal rather than the probe that succeeded beside it", () => {
    // Newest first, as the dashboard fetches them: the probe is the most recent
    // row, but the refusal is the one the operator has to act on.
    const state = deriveFirstCallActivation({
      providerConfigured: true,
      refusalTest: null,
      agents: [{ id: "agent-1", name: "Scout", status: "active" }],
      logs: [probeRow(), row("blocked_scope")],
    });
    expect(state).toMatchObject({ stage: "diagnose", agentId: "agent-1" });
    expect(state.stage === "diagnose" && state.row.status).toBe("blocked_scope");
  });

  it("keeps a refused capability probe visible as a diagnosable attempt", () => {
    // A kill switch refusing a startup probe is not chatter — it is the control
    // working, and the operator needs to see why nothing is getting through.
    const refusedProbe: FirstCallRow = { ...probeRow(), id: "log-killed", status: "blocked_killed", receipt: null };
    expect(deriveFirstCallActivation({
      providerConfigured: true,
      refusalTest: null,
      agents: [{ id: "agent-1", name: "Scout", status: "active" }],
      logs: [refusedProbe],
    })).toMatchObject({ stage: "diagnose", agentId: "agent-1" });
  });

  it("keeps a suspended identity in the flow so its refusal can be diagnosed", () => {
    expect(deriveFirstCallActivation({
      providerConfigured: true,
      refusalTest: null,
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
      refusalTest: null,
        agents: [{ id: "agent-1", name: "Scout", status: "active" }],
        logs: [row(status)],
      }).stage).toBe("diagnose");
    }
    expect(deriveFirstCallActivation({
      providerConfigured: true,
      refusalTest: null,
      agents: [{ id: "agent-1", name: "Scout", status: "active" }],
      logs: [{ ...row("ok"), receipt: null }],
    })).toMatchObject({ stage: "refuse", receiptRecorded: false });
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
    expect(authenticationProofLabel("passport_proof_per_request")).toBe(
      "Passport proof verified per request"
    );
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

    // The provider path authenticates a passport principal with verifyVisa, and
    // never re-checks the passport signature that minted it.
    expect(proxy).toContain("const claims = await verifyVisa(credential.token);");
    expect(proxy).not.toMatch(/verifySignature\(/);

    // Narrowed from a bare /ed25519/i ban, which had been passing for the wrong
    // reason since sender-constrained visas shipped: the proxy DOES verify an
    // Ed25519 signature now — the per-request sender proof — and the old guard
    // stayed green only because that code never wrote the word. Two different
    // signatures at two different boundaries. What this must keep catching is
    // the PASSPORT signature moving here, which is `verifySignature(` above.
    expect(proxy).toContain("verifySenderProof({");
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
  it("persists only dismissal/completion in onboarding_state and never a computed step", () => {
    const page = read("app/dashboard/page.tsx");
    const component = read("components/dashboard/FirstCallActivation.tsx");
    expect(page).toContain('from("onboarding_state")');
    expect(page).toContain('select("dismissed_at, completed_at")');
    expect(page).toContain("onboardingStateHidden");
    expect(component).toContain('.rpc("dismiss_onboarding")');
    expect(component).toContain('.rpc("complete_onboarding")');
    expect(component).not.toContain('from("onboarding_state")');
    expect(component).not.toMatch(/first_provider|provider_complete|agent_complete|call_complete/i);
    expect(page).not.toContain("FIRST_CALL_DISMISSED_COOKIE");
    expect(component).not.toContain("document.cookie");
  });

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
    expect(page).toMatch(/select\("provider", \{ count: "exact" \}\)[\s\S]{0,100}limit\(200\)/);
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
    const reveal = read("components/DirectAgentKeyReveal.tsx");
    const setup = read("lib/direct-connect-config.ts");
    expect(direct).toContain("<DirectAgentKeyReveal");
    expect(reveal).toContain("Copy smoke test");
    expect(direct).toMatch(/preventClose=\{Boolean\(result && !stored\)\}/);
    expect(setup).toContain("smokeCommand");
    expect(setup).not.toContain("model: gpt-*");
  });
});

// ── Step 4: the guide ends on a refusal, not on "it worked" ─────────────────
//
// A stored `ok` inference row proves the path is open. The product is the
// other half: that PassControl says no to something this worker asked for.
// v1 playbook Contract D: an allowed inference, then — after the operator
// starts the guide's refusal test — a `blocked_scope` refusal from the SAME
// worker. A kill-switch toggle, another worker's refusal, or a refusal from
// before the test do not count. The browser only derives `proven`; completion
// is rendered after complete_onboarding() confirms it (0072).
describe("first-call refusal proof", () => {
  const agents = [
    { id: "agent-1", name: "Scout", status: "active", scopes: [{ provider: "openai", models: ["gpt-5-mini"] }] },
    { id: "agent-2", name: "Other", status: "active", scopes: [{ provider: "openai", models: ["gpt-5-mini"] }] },
  ];
  const at = (minute: number) => `2026-08-12T12:${String(minute).padStart(2, "0")}:00.000Z`;
  const logRow = (overrides: Partial<FirstCallRow>): FirstCallRow => ({
    id: `log-${Math.random()}`,
    agent_id: "agent-1",
    provider: "openai",
    model: "gpt-5-mini",
    status: "ok",
    receipt: null,
    created_at: at(0),
    ...overrides,
  });
  const derive = (logs: FirstCallRow[], refusalTest: { agentId: string; startedAt: string } | null) =>
    deriveFirstCallActivation({ providerConfigured: true, agents, logs: [...logs].reverse(), refusalTest });

  it("asks for the refusal test once a call has been admitted, and names a model outside the grant", () => {
    const state = derive([logRow({})], null);
    expect(state).toMatchObject({ stage: "refuse", agentId: "agent-1", test: null });
    expect(state.stage === "refuse" && state.testModel).toBeTruthy();
    expect(state.stage === "refuse" && state.testModel).not.toBe("gpt-5-mini");
  });

  it("is proven by a same-worker scope refusal after the test started", () => {
    const state = derive(
      [logRow({ created_at: at(0) }), logRow({ status: "blocked_scope", model: "gpt-5", created_at: at(6) })],
      { agentId: "agent-1", startedAt: at(5) }
    );
    expect(state).toMatchObject({ stage: "proven", agentId: "agent-1" });
    expect(state.stage === "proven" && state.refusal.model).toBe("gpt-5");
  });

  it("is not proven by a refusal from before the test started", () => {
    const state = derive(
      [logRow({ created_at: at(0) }), logRow({ status: "blocked_scope", model: "gpt-5", created_at: at(3) })],
      { agentId: "agent-1", startedAt: at(5) }
    );
    expect(state).toMatchObject({ stage: "refuse", test: { agentId: "agent-1" } });
  });

  it("is not proven by another worker's refusal", () => {
    const state = derive(
      [logRow({ created_at: at(0) }), logRow({ agent_id: "agent-2", status: "blocked_scope", model: "gpt-5", created_at: at(6) })],
      { agentId: "agent-1", startedAt: at(5) }
    );
    expect(state.stage).toBe("refuse");
  });

  it("is not proven by any other kind of refusal", () => {
    for (const status of ["blocked_killed", "blocked_suspended", "blocked_policy", "blocked_budget"]) {
      const state = derive(
        [logRow({ created_at: at(0) }), logRow({ status, model: "gpt-5", created_at: at(6) })],
        { agentId: "agent-1", startedAt: at(5) }
      );
      expect(state.stage, status).toBe("refuse");
    }
  });

  it("does not pair an allowed call and a refusal made with different installation keys", () => {
    const state = derive(
      [
        logRow({ created_at: at(0), agent_access_key_id: "key-a" }),
        logRow({ status: "blocked_scope", model: "gpt-5", created_at: at(6), agent_access_key_id: "key-b" }),
      ],
      { agentId: "agent-1", startedAt: at(5) }
    );
    expect(state.stage).toBe("refuse");
    const same = derive(
      [
        logRow({ created_at: at(0), agent_access_key_id: "key-a" }),
        logRow({ status: "blocked_scope", model: "gpt-5", created_at: at(6), agent_access_key_id: "key-a" }),
      ],
      { agentId: "agent-1", startedAt: at(5) }
    );
    expect(same.stage).toBe("proven");
  });

  it("does not let a started test skip an earlier stage", () => {
    const test = { agentId: "agent-1", startedAt: at(5) };
    expect(deriveFirstCallActivation({ providerConfigured: false, agents: [], logs: [], refusalTest: test }).stage).toBe("provider");
    expect(deriveFirstCallActivation({ providerConfigured: true, agents: [], logs: [], refusalTest: test }).stage).toBe("agent");
    expect(deriveFirstCallActivation({ providerConfigured: true, agents, logs: [], refusalTest: test }).stage).toBe("call");
  });

  it("chooses a test model the grant refuses, and none when the grant allows everything", () => {
    expect(refusalTestModel([{ provider: "openai", models: ["gpt-5-mini"] }], "openai")).toBe("gpt-5");
    expect(refusalTestModel([{ provider: "openai", models: ["gpt-*"] }], "openai")).toBe("o3");
    expect(refusalTestModel([{ provider: "openai", models: ["*"] }], "openai")).toBeNull();
    expect(refusalTestModel([], "openai")).toBe("gpt-5");
  });

  it("no longer reads the audit log: a stop control is not the proof", () => {
    const lib = read("lib/first-call-activation.ts");
    expect(lib).not.toMatch(/killswitch\.master|agent\.suspend|admin_audit/);
    const page = read("app/dashboard/page.tsx");
    expect(page).not.toMatch(/latestControlExerciseAt|controlExerciseAt/);
  });

  it("renders completion only after the server confirms it", () => {
    const guide = read("components/dashboard/FirstCallActivation.tsx");
    expect(guide).toMatch(/rpc\("complete_onboarding"\)/);
    expect(guide).toMatch(/rpc\("start_onboarding_refusal_test"/);
    expect(guide).toMatch(/confirmation === "confirmed"/);
  });

  it("does not depend on realtime alone while a refusal test is waiting", () => {
    // Found in the local walkthrough on 2026-09-26: the realtime channel reported
    // subscribed but delivered no agent_logs inserts, and the guide sat on
    // "waiting" after the refusal was recorded. A bounded poll of that one
    // agent's rows since the test started covers it.
    const guide = read("components/dashboard/FirstCallActivation.tsx");
    expect(guide).toMatch(/\.eq\("agent_id", waitingAgentId\)[\s\S]{0,80}\.gte\("created_at", waitingSince\)/);
    expect(guide).toMatch(/REFUSAL_POLL_WINDOW_MS = 10 \* 60_000/);
    expect(guide).toMatch(/\.limit\(10\)/);
  });

  it("keeps diagnose in the step order so earlier steps cannot regress", () => {
    // indexOf(-1) at stage `diagnose` makes steps 1 and 2 fail both branches of
    // stepState and render as grey `upcoming` — a refused call would visibly
    // un-complete the provider key the operator just stored.
    const guide = read("components/dashboard/FirstCallActivation.tsx");
    const order = guide.slice(guide.indexOf("const STEP_ORDER"));
    expect(order.slice(0, order.indexOf("]"))).toContain('"diagnose"');
  });
});
