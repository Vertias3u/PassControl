import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ browserClient: vi.fn() }));
import { SpendChart } from "@/components/SpendChart";

it("groups token counts in en-US even when the runtime defaults to German", () => {
  const original = Number.prototype.toLocaleString;
  // Exercise real ICU grouping with a different ambient locale; explicit locales pass through.
  const spy = vi.spyOn(Number.prototype, "toLocaleString").mockImplementation(function (
    this: number, locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions,
  ) {
    return original.call(this, locales ?? "de-DE", options);
  });
  try {
    const html = renderToStaticMarkup(<SpendChart userId="owner" logsAvailable initialLogs={[{
      id: "call", created_at: "2026-10-30T12:30:00.000Z", provider: "openai", model: "model",
      input_tokens: 1234, output_tokens: 0, cost_microcents: 100,
    }]} />);
    expect(html).toContain("1,234");
    expect(html).not.toContain("1.234");
  } finally {
    spy.mockRestore();
  }
});
