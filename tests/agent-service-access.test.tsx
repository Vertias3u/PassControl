// The agent page's service access editor.
//
// Simple mode first: a repository and plain-language choices, which write the
// rules (lib/services/presets.ts). Every saved rule no choice wrote is shown
// under Advanced as a custom rule with its own method, so it is never lost: an
// editor that dropped it, or showed a write rule as GET, would change an
// agent's access the next time anything on the form was saved.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/dashboard/service-actions", () => ({ setAgentServiceRules: vi.fn() }));

const { AgentServiceAccess } = await import("@/components/AgentServiceAccess");

const REPO = "Vertias3u/testrepo1345";

const render = (initialAllow: { method: string; path: string }[]) =>
  renderToStaticMarkup(
    <AgentServiceAccess
      agentId="11111111-1111-4111-8111-111111111111"
      service="github"
      serviceLabel="GitHub"
      initialAllow={initialAllow}
      initialCap={null}
      state="ok"
      tokenStored
    />
  );

const checkedPresets = (html: string) =>
  [...html.matchAll(/<input type="checkbox"[^>]*data-preset="([a-z]+)"[^>]*>/g)]
    .filter((m) => / checked=""/.test(m[0]))
    .map((m) => m[1]);

describe("the GitHub access editor, simple mode", () => {
  it("shows a saved preset list as its repository and ticked choices, with no custom rule", () => {
    const html = render([
      { method: "GET", path: `/repos/${REPO}` },
      { method: "GET", path: `/repos/${REPO}/**` },
      { method: "POST", path: `/repos/${REPO}/issues` },
    ]);
    expect(html).toMatch(new RegExp(`data-field="repo"[^>]*value="${REPO}"|value="${REPO}"[^>]*data-field="repo"`));
    expect(checkedPresets(html)).toEqual(["read", "issues"]);
    expect(html).not.toMatch(/data-service-rule=/);
    expect(html).toMatch(/data-service-advanced="closed"/);
  });

  it("offers the four plain-language choices", () => {
    const html = render([]);
    expect(html).toMatch(/Read code, issues and pull requests/);
    expect(html).toMatch(/Open issues/);
    expect(html).toMatch(/Comment on issues and pull requests/);
    expect(html).toMatch(/Open pull requests/);
  });

  it("says plainly when the agent has no GitHub access", () => {
    expect(render([])).toMatch(/data-service-summary="none"/);
  });

  it("states the never list in one line, outside Advanced", () => {
    const html = render([]);
    const advanced = html.indexOf("data-service-advanced");
    const never = html.indexOf("data-service-never");
    expect(never).toBeGreaterThan(-1);
    expect(never).toBeLessThan(advanced);
    expect(html.slice(never, advanced)).toMatch(/never allowed/);
  });
});

describe("the GitHub access editor, custom rules under Advanced", () => {
  it("shows each rule no choice wrote with its own method selected, and opens Advanced for it", () => {
    const html = render([
      { method: "GET", path: "/repos/acme/*/issues" },
      { method: "PUT", path: "/repos/acme/web/contents/README.md" },
    ]);
    expect(html).toMatch(/data-service-advanced="open"/);
    expect(html).toMatch(/data-service-rule="0" data-rule-method="GET"/);
    expect(html).toMatch(/data-service-rule="1" data-rule-method="PUT"/);
    const second = html.slice(html.indexOf('data-service-rule="1"'));
    expect(second).toMatch(/<option value="PUT" selected="">PUT<\/option>/);
  });

  it("keeps a rule for another repository as a custom rule beside the ticked choices", () => {
    const html = render([
      { method: "GET", path: `/repos/${REPO}` },
      { method: "GET", path: `/repos/${REPO}/**` },
      { method: "POST", path: "/repos/acme/web/issues" },
    ]);
    expect(checkedPresets(html)).toEqual(["read"]);
    expect(html).toMatch(/data-service-rule="0" data-rule-method="POST"/);
    expect(html).toMatch(/value="\/repos\/acme\/web\/issues"/);
  });

  it("offers every method the gateway accepts, and no other", () => {
    const html = render([{ method: "GET", path: "/user" }]);
    const options = [...html.matchAll(/<option value="([A-Z]+)"/g)].map((m) => m[1]);
    expect(options).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE"]);
  });

  it("explains * and ** where custom rules are written", () => {
    expect(render([])).toMatch(/for <code>GET<\/code> rules only/);
  });
});

describe("the Telegram access editor", () => {
  const renderTelegram = (initialAllow: { method: string; path: string }[]) =>
    renderToStaticMarkup(
      <AgentServiceAccess
        agentId="11111111-1111-4111-8111-111111111111"
        service="telegram"
        serviceLabel="Telegram"
        ruleShape="call"
        initialAllow={initialAllow}
        initialCap={null}
        state="ok"
        tokenStored
      />
    );

  it("reads sendMessage back as the Send messages choice, with no repository field", () => {
    const html = renderTelegram([{ method: "CALL", path: "sendMessage" }]);
    expect(checkedPresets(html)).toEqual(["send"]);
    expect(html).not.toMatch(/data-field="repo"/);
    expect(html).not.toMatch(/data-service-rule=/);
  });

  it("asks for a method name for a custom rule, with no HTTP verb to pick", () => {
    const html = renderTelegram([{ method: "CALL", path: "sendPhoto" }]);
    expect(html).toMatch(/data-rule-method="CALL"/);
    expect(html).not.toMatch(/<select/);
    expect(html).toMatch(/value="sendPhoto"/);
  });

  it("says what a send rule can reach, and what is never allowed", () => {
    const html = renderTelegram([]);
    expect(html).toMatch(/any chat the bot is in/);
    expect(html).toMatch(/setWebhook/);
  });
});

describe("\"Ask me first\" in the access editor", () => {
  const renderWith = (
    service: string,
    serviceLabel: string,
    initialAllow: { method: string; path: string; ask?: boolean }[],
    alertDestination?: "telegram" | "slack" | "discord" | null
  ) =>
    renderToStaticMarkup(
      <AgentServiceAccess
        agentId="11111111-1111-4111-8111-111111111111"
        service={service}
        serviceLabel={serviceLabel}
        initialAllow={initialAllow}
        initialCap={null}
        state="ok"
        tokenStored
        alertDestination={alertDestination}
      />
    );
  const askBox = (html: string) => /<input type="checkbox"[^>]*data-field="ask-writes"[^>]*>/.exec(html)?.[0] ?? null;

  it("offers the switch where a service has writes, unticked for a list with none asking", () => {
    const html = renderWith("github", "GitHub", [{ method: "POST", path: `/repos/${REPO}/issues` }]);
    expect(askBox(html)).not.toBeNull();
    expect(askBox(html)).not.toMatch(/ checked=""/);
    expect(html).not.toMatch(/data-service-ask-destination/);
  });

  it("shows it ticked when every write asks, and says where the questions go", () => {
    const html = renderWith(
      "github",
      "GitHub",
      [
        { method: "GET", path: `/repos/${REPO}` },
        { method: "GET", path: `/repos/${REPO}/**` },
        { method: "POST", path: `/repos/${REPO}/issues`, ask: true },
      ],
      "telegram"
    );
    expect(askBox(html)).toMatch(/ checked=""/);
    expect(html).toMatch(/data-service-ask-destination="telegram"/);
    expect(html).toMatch(/Approve and Deny buttons/);
  });

  it("warns when there is no alert destination to ask on", () => {
    const html = renderWith("github", "GitHub", [{ method: "POST", path: `/repos/${REPO}/issues`, ask: true }], null);
    expect(html).toMatch(/data-service-ask-destination="none"/);
    expect(html).toMatch(/only appear on the Approvals page/);
  });

  it("does not offer it for a service whose calls are all reads (Brave Search)", () => {
    expect(askBox(renderWith("brave", "Brave Search", []))).toBeNull();
  });

  it("keeps a custom rule's own ask ticked under Advanced", () => {
    const html = renderWith("github", "GitHub", [{ method: "GET", path: "/user", ask: true }]);
    expect(html).toMatch(/<input type="checkbox"[^>]*checked=""[^>]*data-field="rule-ask"|data-field="rule-ask"[^>]*checked=""/);
  });
});
