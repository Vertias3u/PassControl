// Settings → Services: which token can be deleted (0075).
//
// The only token for a service can go — there is nothing to promote in its
// place — but only behind a confirmation that says what stops. A token in use
// with a sibling still says "switch first", because the database refuses it.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/dashboard/actions", () => ({
  deleteProviderKey: vi.fn(),
  rotateProviderKey: vi.fn(),
  setActiveProviderKey: vi.fn(),
}));
vi.mock("@/app/dashboard/service-actions", () => ({ addServiceToken: vi.fn() }));

const { ServiceTokensManager } = await import("@/components/ServiceTokensManager");

const token = (id: string, isActive: boolean, created = "2026-09-30T00:00:00Z") => ({
  id,
  provider: "svc:github",
  label: id,
  is_active: isActive,
  created_at: created,
});
const render = (tokens: ReturnType<typeof token>[]) =>
  renderToStaticMarkup(<ServiceTokensManager service="github" serviceLabel="GitHub" tokens={tokens as never} />);

/** The Delete button inside one token's row. */
function deleteButton(html: string, id: string): string {
  const row = html.slice(html.indexOf(`data-service-token="${id}"`));
  const button = row.match(/<button[^>]*data-action="delete-service-token"[^>]*>/);
  if (!button) throw new Error(`no delete button for ${id}`);
  return button[0];
}

describe("deleting a service token", () => {
  it("lets the only token be deleted, even though it is in use", () => {
    const button = deleteButton(render([token("only", true)]), "only");
    expect(button).not.toMatch(/\sdisabled/);
    expect(button).toContain('data-delete-kind="last"');
  });

  it("still asks for a switch first when the token in use has a sibling", () => {
    const html = render([token("inuse", true, "2026-09-30T00:00:02Z"), token("spare", false)]);
    expect(deleteButton(html, "inuse")).toMatch(/\sdisabled/);
    expect(deleteButton(html, "inuse")).toMatch(/Add and switch to another one first|Switch to another/);
    expect(deleteButton(html, "spare")).not.toMatch(/\sdisabled/);
    expect(deleteButton(html, "spare")).toContain('data-delete-kind="idle"');
  });
});
