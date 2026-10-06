// Brave Search in the any-API catalog (plans/any-api-credentials.md §13, S1).
//
// MONEY: Brave bills per request with no spending cap on its side (the free
// plan was retired in 2026; a card is required). So an agent's hourly call cap
// is the operator's bill guard, and Brave's default is lower than every other
// service's: a rule set that names no cap must not mean 500 calls an hour.
import { describe, expect, it } from "vitest";

import { SERVICE_CATALOG, isServiceId, serviceRefusal } from "@/lib/services/catalog";
import { SERVICE_DISPLAY } from "@/lib/services/display";
import { DEFAULT_SERVICE_HOURLY_CAP, defaultHourlyCapFor, parseServiceRules } from "@/lib/services/rules";

const KEY = "BSAexampleSubscriptionToken0123456789";

describe("Brave Search's call cap", () => {
  it("defaults to 30 calls an hour when the rules name none", () => {
    expect(defaultHourlyCapFor("brave")).toBe(30);
    const read = parseServiceRules({ brave: { allow: [{ method: "GET", path: "/web/search" }] } }, "brave");
    expect(read).toMatchObject({ kind: "rules", rules: { maxRequestsPerHour: 30 } });
  });

  it("honours a cap the operator chose", () => {
    const read = parseServiceRules({ brave: { allow: [{ method: "GET", path: "/web/search" }], max_requests_per_hour: 100 } }, "brave");
    expect(read).toMatchObject({ kind: "rules", rules: { maxRequestsPerHour: 100 } });
  });

  it("says the same number wherever the copy states it", () => {
    const cap = String(defaultHourlyCapFor("brave"));
    expect(SERVICE_CATALOG.brave.neverSummary).toContain(`${cap} calls an hour`);
    expect(SERVICE_DISPLAY.brave.accessDescription).toContain(`${cap} searches an hour`);
    expect(SERVICE_DISPLAY.brave.settingsHint).toContain(`(${cap} unless`);
  });

  it("leaves every other service's default where it was", () => {
    expect(defaultHourlyCapFor("github")).toBe(DEFAULT_SERVICE_HOURLY_CAP);
    expect(defaultHourlyCapFor("telegram")).toBe(DEFAULT_SERVICE_HOURLY_CAP);
    expect(defaultHourlyCapFor("not-a-service")).toBe(DEFAULT_SERVICE_HOURLY_CAP);
  });
});

describe("Brave Search's catalog entry", () => {
  const brave = SERVICE_CATALOG.brave;

  it("is a catalog service with its own credential namespace", () => {
    expect(isServiceId("brave")).toBe(true);
    expect(brave.credentialProvider).toBe("svc:brave");
    expect(brave.label).toBe("Brave Search");
  });

  it("pins /res/v1: the agent's path starts after it, and cannot pick another", () => {
    expect(brave.upstreamUrl(KEY, "/web/search", "?q=passcontrol")).toBe(
      "https://api.search.brave.com/res/v1/web/search?q=passcontrol"
    );
  });

  it("authenticates with X-Subscription-Token, never Authorization", () => {
    expect(brave.authHeaders(KEY)).toEqual({ "x-subscription-token": KEY });
  });

  it("refuses a key that could not be put in a header safely", () => {
    expect(brave.tokenShape?.test(KEY)).toBe(true);
    expect(brave.tokenShape?.test("bad key\r\nx-evil: 1")).toBe(false);
    expect(brave.tokenShape?.test("")).toBe(false);
  });

  it("is read-only: every write is refused whatever the rules say", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(serviceRefusal(brave, method, ["web", "search"])).toMatch(/read-only/);
    }
    expect(serviceRefusal(brave, "GET", ["web", "search"])).toBeNull();
    expect(serviceRefusal(brave, "HEAD", ["web", "search"])).toBeNull();
    expect(brave.isWriteRule({ method: "GET", path: "/web/search" })).toBe(false);
  });

  it("refuses the token-billed answer endpoint, which is an LLM call", () => {
    expect(serviceRefusal(brave, "GET", ["chat", "completions"])).toMatch(/LLM/);
  });

  it("forwards no body type and no rewritten URLs", () => {
    expect(brave.bodyTypes).toEqual([]);
    expect(brave.rewritesUrls).toBe(false);
  });
});

describe("Brave Search's cap wording", () => {
  it("never tells an operator a Brave call is free", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("components/AgentServiceAccess.tsx", "utf8");
    // The generic sentence ("has no price") is kept for unbilled services only.
    expect(source).toMatch(/billedPerCall\s*\?/u);
    expect(SERVICE_DISPLAY.brave.billedPerCall).toBe(true);
    expect(SERVICE_DISPLAY.github.billedPerCall).toBeFalsy();
  });
});
