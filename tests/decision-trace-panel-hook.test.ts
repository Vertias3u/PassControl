// G1 — the decision-trace panel used ReactDOM.useFormState, which the React 19
// that Next's App Router runs has renamed: every visit to an agent page logged
// "ReactDOM.useFormState has been renamed to React.useActionState" as a console
// ERROR (seen in the browser, 2026-09-26). Source-level on purpose: vitest
// resolves the repository's React 18, which has no useActionState to render with
// (see tests/statement-chain-render.test.tsx), so a render test here would be
// testing a mock.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("app/dashboard/agents/[id]/DecisionTracePanel.tsx", "utf8");

describe("DecisionTracePanel form state", () => {
  it("uses React.useActionState, not the renamed ReactDOM.useFormState", () => {
    expect(source).not.toMatch(/\buseFormState\b/);
    expect(source).toMatch(/import\s*\{[^}]*\buseActionState\b[^}]*\}\s*from\s*"react"/);
  });

  it("keeps useFormStatus for the submit button, which was not renamed", () => {
    expect(source).toMatch(/import\s*\{[^}]*\buseFormStatus\b[^}]*\}\s*from\s*"react-dom"/);
  });
});
