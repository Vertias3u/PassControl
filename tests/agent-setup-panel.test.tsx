// v1 playbook Session 04, requirement 4 and Contract B: a founder who saved
// the Direct Agent Key and closed the reveal must be able to reconnect the
// worker without issuing a new key. The Setup section on the agent page is
// that path. It is rebuilt from what PassControl stores — agent, scopes, key
// metadata — and so it can never contain a key: only a hash exists.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentSetupPanel } from "@/components/AgentSetupPanel";
import { setupExampleModel } from "@/lib/agent-connect";

const activeKey = {
  id: "k1",
  name: "Build server",
  suffix: "AbCdEf12",
  createdAt: "2026-09-20T10:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  recordedCalls: 0,
};

describe("the example model a reopened Setup uses", () => {
  it("prefers a concrete model from the agent's own grant", () => {
    expect(setupExampleModel([{ provider: "openai", models: ["gpt-*", "gpt-5-mini"] }], "openai")).toBe("gpt-5-mini");
  });

  it("falls back to the provider default only when the grant covers it", () => {
    expect(setupExampleModel([{ provider: "openai", models: ["gpt-*"] }], "openai")).toBe("gpt-5-mini");
    expect(setupExampleModel([{ provider: "openai", models: ["o3-*"] }], "openai")).toBeNull();
  });

  it("never offers a wildcard as the model a client sends", () => {
    expect(setupExampleModel([{ provider: "anthropic", models: ["claude-*"] }], "anthropic")).toBe("claude-haiku-4-5");
    expect(setupExampleModel([{ provider: "anthropic", models: ["*"] }], "anthropic")).toBe("claude-haiku-4-5");
  });
});

describe("AgentSetupPanel", () => {
  const render = (overrides: Partial<Parameters<typeof AgentSetupPanel>[0]> = {}) =>
    renderToStaticMarkup(
      <AgentSetupPanel
        agentId="agent-1"
        agentName="Scout"
        status="active"
        scopes={[{ provider: "openai", models: ["gpt-5-mini"] }]}
        keys={[activeKey]}
        {...overrides}
      />
    );

  it("renders a complete, key-less setup with install, file, load and smoke steps", () => {
    const html = render();
    expect(html).toContain('id="agent-setup"');
    expect(html).toContain("npm install openai");
    expect(html).toContain("OPENAI_BASE_URL=");
    expect(html).toContain("OPENAI_API_KEY=PASTE_YOUR_DIRECT_AGENT_KEY");
    expect(html).toContain("set -a; . ./passcontrol.env; set +a");
    // One paste writes the file and loads it (2026-10-04: a pasted env block
    // left the key in unexported shell variables an SDK never reads).
    expect(html).toContain("cat &gt; passcontrol.env &lt;&lt;&#x27;PASSCONTROL_ENV&#x27;");
    expect(html).toMatch(/project folder/i);
    expect(html).toMatch(/new terminal/i);
    expect(html).toMatch(/edit passcontrol\.env/i);
    expect(html).toContain(".gitignore");
    expect(html).toContain("/api/v1/openai/v1/chat/completions");
    expect(html).toMatch(/replace the provider key/i);
    expect(html).not.toMatch(/pc_agent_[A-Za-z0-9_-]{20,}/u);
  });

  it("names the installation keys by suffix only, and sends a lost key to replacement", () => {
    const html = render();
    expect(html).toContain("Build server");
    expect(html).toContain("AbCdEf12");
    expect(html).toMatch(/lost/i);
    expect(html).toContain('href="#direct-agent-keys"');
  });

  it("uses the native Anthropic shape for an Anthropic grant", () => {
    const html = render({ scopes: [{ provider: "anthropic", models: ["claude-haiku-4-5"] }] });
    expect(html).toContain("npm install @anthropic-ai/sdk");
    expect(html).toContain("ANTHROPIC_API_KEY=PASTE_YOUR_DIRECT_AGENT_KEY");
    expect(html).toContain("/api/v1/anthropic/v1/messages");
    expect(html).not.toContain("OPENAI_BASE_URL");
  });

  it("says what is missing instead of inventing a model the grant does not cover", () => {
    const html = render({ scopes: [{ provider: "openai", models: ["o3-*"] }] });
    expect(html).toContain('data-setup-state="needs-model"');
    expect(html).not.toContain("OPENAI_MODEL=gpt-5-mini");
  });

  it("says setup is unavailable when the agent has no active installation key", () => {
    const html = render({ keys: [{ ...activeKey, revokedAt: "2026-09-21T10:00:00.000Z" }] });
    expect(html).toContain('data-setup-state="no-active-key"');
  });

  it("does not offer setup for a revoked agent", () => {
    const html = render({ status: "revoked" });
    expect(html).toContain('data-setup-state="revoked"');
    expect(html).not.toContain("OPENAI_BASE_URL=");
  });
});
