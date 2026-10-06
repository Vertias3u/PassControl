// Local models (1.2.0): where the `local` provider is offered. The choosers read
// the operator gate from the dashboard shell's context (LocalModels.tsx), whose
// default is OFF, so a chooser rendered outside the shell behaves as hosted
// Cloud does.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/dashboard/actions-client", () => ({}));

const { ProviderKeysManager } = await import("@/components/ProviderKeysManager");
const { LocalModelsProvider } = await import("@/components/dashboard/LocalModels");

const options = (html: string) => [...html.matchAll(/<option value="([^"]+)"/gu)].map((m) => m[1]);
const localCredential = {
  id: "c1",
  provider: "local",
  label: "ollama",
  created_at: "2026-10-05T00:00:00Z",
  is_active: true,
  endpoint_base_url: "http://localhost:11434/v1",
};

describe("the provider credential chooser", () => {
  it("does not offer local where the gate is off", () => {
    expect(options(renderToStaticMarkup(<ProviderKeysManager credentials={[]} />))).not.toContain("local");
  });

  it("offers local where the gate is open", () => {
    const html = renderToStaticMarkup(
      <LocalModelsProvider enabled>
        <ProviderKeysManager credentials={[]} />
      </LocalModelsProvider>
    );
    expect(options(html)).toContain("local");
  });

  it("still lists local when a local credential is stored, so turning the gate off never hides one", () => {
    expect(options(renderToStaticMarkup(<ProviderKeysManager credentials={[localCredential]} />))).toContain("local");
  });
});
