// Scope-filtered model listing.
//
// `GET /v1/models` used to return every model the PROVIDER KEY can reach, which
// is not the same set as the models the VISA permits — so an SDK's model picker
// offered choices that were guaranteed to 403 on first use. Narrowing the
// provider's own response to the visa's scope makes the gateway visibly be the
// capability boundary it already enforces.
//
// Two properties are load-bearing:
//   1. It is a NARROWING of real provider data, never an invention. Nothing is
//      added, no field is synthesised, and an entry that survives is byte-equal.
//   2. It is presentation, not enforcement. Scope is already enforced at the
//      gate; if a response shape is unrecognised this passes it through
//      untouched rather than guessing — a models list was never a secret.
import { describe, it, expect } from "vitest";
import { filterModelListingToScope } from "@/lib/providers/model-listing";
import type { ScopeEntry } from "@/lib/auth/visa";

const scopes: ScopeEntry[] = [{ provider: "openai", models: ["gpt-4*", "o3-mini"] }];

const openaiList = () => ({
  object: "list",
  data: [
    { id: "gpt-4.1", object: "model", created: 1, owned_by: "openai" },
    { id: "gpt-3.5-turbo", object: "model", created: 2, owned_by: "openai" },
    { id: "o3-mini", object: "model", created: 3, owned_by: "openai" },
    { id: "dall-e-3", object: "model", created: 4, owned_by: "openai" },
  ],
});

describe("filterModelListingToScope", () => {
  it("keeps only the models the visa permits", () => {
    const out = filterModelListingToScope(openaiList(), "openai", scopes) as any;
    expect(out.data.map((m: any) => m.id)).toEqual(["gpt-4.1", "o3-mini"]);
  });

  it("leaves a surviving entry byte-identical", () => {
    // A narrowing, not a rewrite: every field the provider sent is still there.
    const out = filterModelListingToScope(openaiList(), "openai", scopes) as any;
    expect(out.data[0]).toEqual({ id: "gpt-4.1", object: "model", created: 1, owned_by: "openai" });
  });

  it("preserves every other top-level field", () => {
    const out = filterModelListingToScope(openaiList(), "openai", scopes) as any;
    expect(out.object).toBe("list");
  });

  it("returns an empty list rather than everything when nothing is scoped", () => {
    // The failure direction matters: an empty list is a true statement about a
    // visa with no matching scope. Falling back to the full list would undo the
    // whole point on exactly the agent that most needs narrowing.
    const out = filterModelListingToScope(openaiList(), "openai", [
      { provider: "openai", models: ["nothing-*"] },
    ]) as any;
    expect(out.data).toEqual([]);
  });

  it("matches scope against the provider being listed, not another one", () => {
    // Scope is per-provider. An anthropic listing must not be admitted by an
    // openai scope entry.
    const out = filterModelListingToScope(
      { object: "list", data: [{ id: "gpt-4.1" }] },
      "anthropic",
      scopes
    ) as any;
    expect(out.data).toEqual([]);
  });

  it("filters the anthropic list shape too", () => {
    const anthropic = {
      data: [
        { type: "model", id: "claude-sonnet-4-20250514", display_name: "Sonnet" },
        { type: "model", id: "claude-3-opus-20240229", display_name: "Opus" },
      ],
      has_more: false,
      first_id: "claude-sonnet-4-20250514",
      last_id: "claude-3-opus-20240229",
    };
    const out = filterModelListingToScope(anthropic, "anthropic", [
      { provider: "anthropic", models: ["claude-sonnet-4*"] },
    ]) as any;
    expect(out.data.map((m: any) => m.id)).toEqual(["claude-sonnet-4-20250514"]);
  });

  it("keeps pagination cursors consistent with what it returns", () => {
    // first_id/last_id that name rows no longer in `data` would send a paging
    // client to a cursor it cannot see.
    const anthropic = {
      data: [{ id: "a" }, { id: "b" }, { id: "c" }],
      has_more: true,
      first_id: "a",
      last_id: "c",
    };
    const out = filterModelListingToScope(anthropic, "anthropic", [
      { provider: "anthropic", models: ["b"] },
    ]) as any;
    expect(out.first_id).toBe("b");
    expect(out.last_id).toBe("b");
    // has_more is the provider's statement about ITS pages, not ours. Untouched.
    expect(out.has_more).toBe(true);
  });

  it("nulls the cursors when the page filters to empty", () => {
    const out = filterModelListingToScope(
      { data: [{ id: "a" }], first_id: "a", last_id: "a" },
      "anthropic",
      [{ provider: "anthropic", models: ["zzz"] }]
    ) as any;
    expect(out.first_id).toBeNull();
    expect(out.last_id).toBeNull();
  });

  it("leaves cursors absent when the provider sent none", () => {
    const out = filterModelListingToScope(openaiList(), "openai", scopes) as any;
    expect("first_id" in out).toBe(false);
  });

  it("drops an entry with no usable id", () => {
    // A client cannot name it, so it cannot select it — and it must not survive
    // a filter whose entire job is identification.
    const out = filterModelListingToScope(
      { data: [{ id: "gpt-4.1" }, { object: "model" }, { id: 42 }] },
      "openai",
      scopes
    ) as any;
    expect(out.data.map((m: any) => m.id)).toEqual(["gpt-4.1"]);
  });

  // ── Pass-through: this must never be the thing that breaks a response ──────
  it("passes an unrecognised shape through untouched", () => {
    for (const body of [null, undefined, 42, "text", [], { error: { message: "nope" } }]) {
      expect(filterModelListingToScope(body, "openai", scopes)).toBe(body);
    }
  });

  it("passes through when data is present but not an array", () => {
    const body = { object: "list", data: { id: "gpt-4.1" } };
    expect(filterModelListingToScope(body, "openai", scopes)).toBe(body);
  });

  it("does not mutate the response it was given", () => {
    const body = openaiList();
    filterModelListingToScope(body, "openai", scopes);
    expect(body.data).toHaveLength(4);
  });

  it("passes through when the visa carries no scope at all", () => {
    // Undefined scope is "not supplied yet", not "nothing permitted". Filtering
    // to empty on a missing input would invent a restriction.
    const body = openaiList();
    expect(filterModelListingToScope(body, "openai", undefined)).toBe(body);
  });

  it("treats an EMPTY scope list as a real restriction, not a missing input", () => {
    // The distinction that decides whether both auth paths behave alike. A
    // credential that grants nothing must list nothing; only an ABSENT scope is
    // "unknown". Both principals supply a required array — a passport visa from
    // `claims.scope`, a Direct Agent Key from `unionScopes(base, elevated)` —
    // so the undefined branch above is unreachable from the proxy and direct-key
    // agents get the same narrowed listing as passport agents.
    const out = filterModelListingToScope(openaiList(), "openai", []) as any;
    expect(out.data).toEqual([]);
  });
});
