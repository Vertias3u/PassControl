// C1 prevention — the passport reveal must not leave room to read a static-key
// client's API-key field as a place for the Passport secret (the Hermes
// incident: a private key in a config file for four days).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/lib/supabase/client", () => ({ browserClient: () => ({}) }));

const { PassportStoreAndConnect } = await import("@/components/PassportStoreAndConnect");

const render = (initialMode: "sdk" | "sidecar" | "mcp") =>
  renderToStaticMarkup(
    <PassportStoreAndConnect
      userId="u1"
      agentId="a1"
      issuedAt="2026-09-26T00:00:00Z"
      provider="openai"
      model="gpt-5-mini"
      passportId={"P".repeat(43)}
      passportSecret={"S".repeat(43)}
      initialMode={initialMode}
      integrations={["generic", "hermes"]}
      stored={false}
      onStoredChange={() => {}}
      onFinish={() => {}}
    />
  );

describe("the passport reveal", () => {
  it("names a client's API-key field among the places the secret must never go", () => {
    expect(render("sdk")).toMatch(/a client&#x27;s API-key or token field/);
  });

  it("says the sidecar holds the secret and the tool gets only the placeholder", () => {
    const html = render("sidecar");
    expect(html).toContain("data-sidecar-key-note");
    expect(html).toMatch(/never the Passport secret/);
    expect(html).toMatch(/use a Direct Agent Key/);
  });
});
