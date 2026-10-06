// Slice B: an agent created to call services only (no model access). The key
// reveal and the agent's Setup tell it how to reach GitHub and Telegram, and
// never hand it model-SDK configuration it could not use.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { DirectAgentKeyReveal } = await import("@/components/DirectAgentKeyReveal");
const { AgentSetupPanel } = await import("@/components/AgentSetupPanel");

describe("a services-only agent", () => {
  it("is revealed with GitHub and Telegram setup, and no model SDK block", () => {
    const html = renderToStaticMarkup(
      <DirectAgentKeyReveal
        issued={{ agentId: "a1", keyId: "k1", key: "pc_dak_secret", name: "triage", keyName: "ci", expiresAt: null, provider: null, model: null }}
        stored={false}
        onStoredChange={() => undefined}
        onDone={() => undefined}
      />
    );
    expect(html).toContain('data-client-family="services"');
    expect(html).toContain("GITHUB_API_URL=");
    expect(html).toContain("/dashboard/agents/a1#agent-services");
    expect(html).not.toMatch(/Install the SDK|First-call smoke test|Hermes/);
  });

  it("gets service setup on its Setup panel instead of being told to add a provider", () => {
    const html = renderToStaticMarkup(
      <AgentSetupPanel
        agentId="a1"
        agentName="triage"
        status="active"
        scopes={[]}
        keys={[{ id: "k1", name: "ci", suffix: "abcd1234", expiresAt: null, revokedAt: null }]}
      />
    );
    expect(html).toContain('data-setup-state="no-provider"');
    expect(html).toContain("data-setup-services-only");
    expect(html).toContain("GITHUB_API_URL=");
    expect(html).toContain("#agent-services-telegram");
  });
});

describe("a services-only passport's Store & connect step", () => {
  it("offers SDK and sidecar only, with Octokit through pc.fetch and no model SDK", async () => {
    vi.doMock("@/lib/supabase/client", () => ({ browserClient: () => ({}) }));
    const { PassportStoreAndConnect } = await import("@/components/PassportStoreAndConnect");
    const html = renderToStaticMarkup(
      <PassportStoreAndConnect
        userId="u1"
        agentId="a1"
        issuedAt="2026-10-02T00:00:00Z"
        provider={null}
        model={null}
        passportId="pid"
        passportSecret="s3cr3t"
        initialMode="sdk"
        integrations={["generic"]}
        stored={false}
        onStoredChange={() => undefined}
        onFinish={() => undefined}
      />
    );
    expect(html).toContain('data-client-family="services"');
    expect(html).toContain("request: { fetch: passcontrol.fetch }");
    expect(html).toContain('data-setup-note="services-only"');
    expect(html).not.toMatch(/>MCP</);
    expect(html).not.toMatch(/Connect the provider SDK|clientOptions/);
    // The secret appears once, in the env block.
    expect(html.split("s3cr3t").length - 1).toBe(1);
  });
});

describe("the capability card on a services-only agent", () => {
  // Found on Cloud 2026-10-02: an agent with GitHub and Telegram rules and no
  // model scope was told "No scopes — this agent can reach nothing."
  const card = readFileSync("components/AgentPassport.tsx", "utf8");
  const page = readFileSync("app/dashboard/agents/[id]/page.tsx", "utf8");

  it("says no model access and names the services, instead of 'nothing'", () => {
    const servicesBranch = card.indexOf('data-scopes="services-only"');
    const nothingBranch = card.indexOf('data-scopes="none"');
    expect(servicesBranch).toBeGreaterThan(-1);
    // Checked first: the "nothing" warning is reached only with no services.
    expect(servicesBranch).toBeLessThan(nothingBranch);
    expect(card.slice(servicesBranch, nothingBranch)).toMatch(/No model access\./);
  });

  it("is told which services the agent has rules for", () => {
    // Every catalog service (lib/services/display.ts), named only where the
    // agent has at least one rule; no service is listed by hand on the page.
    expect(page).toMatch(/<AgentPassport[\s\S]*?services=\{serviceAccess\s*\.filter\(\(\{ access \}\) => access\.state === "ok" && access\.allow\.length > 0\)\s*\.map\(\(\{ label \}\) => label\)\}/);
    expect(page).toMatch(/DISPLAYED_SERVICES\.map\(async \(service\)/);
  });
});
