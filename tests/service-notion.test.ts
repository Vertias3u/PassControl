// Notion in the any-API catalog (plans/any-api-credentials.md §13, S2).
// Endpoint facts from developers.notion.com reference pages (read 2026-10-05).
import { describe, expect, it } from "vitest";

import { SERVICE_CATALOG, isServiceId, serviceRefusal } from "@/lib/services/catalog";
import { DEFAULT_SERVICE_HOURLY_CAP, defaultHourlyCapFor } from "@/lib/services/rules";

const TOKEN = "ntn_example0123456789abcdefghijklmnopqrstuvwxyzAB";
const notion = SERVICE_CATALOG.notion;
const seg = (path: string) => path.replace(/^\//u, "").split("/");
const refuse = (method: string, path: string) => serviceRefusal(notion, method, seg(path));

describe("Notion's catalog entry", () => {
  it("is a catalog service with its own credential namespace and the shared cap", () => {
    expect(isServiceId("notion")).toBe(true);
    expect(notion.credentialProvider).toBe("svc:notion");
    expect(notion.label).toBe("Notion");
    expect(defaultHourlyCapFor("notion")).toBe(DEFAULT_SERVICE_HOURLY_CAP);
  });

  it("keeps /v1 in the agent's path, as Notion's SDK sends it, and pins the host", () => {
    expect(notion.upstreamUrl(TOKEN, "/v1/pages/abc", "")).toBe("https://api.notion.com/v1/pages/abc");
  });

  it("refuses any path outside /v1", () => {
    expect(refuse("GET", "/pages/abc")).toMatch(/v1/);
    expect(refuse("GET", "/v2/pages/abc")).toMatch(/v1/);
    expect(refuse("GET", "/v1/pages/abc")).toBeNull();
  });

  it("authenticates with Bearer and forwards the agent's Notion-Version", () => {
    expect(notion.authHeaders(TOKEN)).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(notion.requestHeaders).toContain("notion-version");
    expect(notion.tokenShape?.test(TOKEN)).toBe(true);
    expect(notion.tokenShape?.test("ntn_x\r\nx-evil: 1")).toBe(false);
  });

  it.each([
    ["POST", "/v1/oauth/token"],
    ["POST", "/v1/oauth/revoke"],
    ["POST", "/v1/oauth/introspect"],
    ["GET", "/v1/oauth/anything"],
    ["POST", "/v1/file_uploads"],
    ["POST", "/v1/file_uploads/f1/send"],
    ["POST", "/v1/sessions"],
    ["POST", "/v1/sessions/s1/cancel"],
    ["PATCH", "/v1/agents/a1/status"],
    ["PATCH", "/v1/agents/a1/credit_limit"],
    ["DELETE", "/v1/agents/a1"],
    ["POST", "/v1/agents/batch"],
    ["post", "/V1/OAUTH/token"],
  ])("refuses %s %s whatever the rules say", (method, path) => {
    expect(refuse(method, path)).not.toBeNull();
  });

  it.each([
    ["GET", "/v1/pages/p1"],
    ["POST", "/v1/pages"],
    ["PATCH", "/v1/blocks/b1/children"],
    ["DELETE", "/v1/blocks/b1"],
    ["POST", "/v1/search"],
    ["POST", "/v1/data_sources/d1/query"],
    ["GET", "/v1/file_uploads/f1"],
    ["POST", "/v1/agents/query"],
    ["POST", "/v1/sessions/query"],
    ["POST", "/v1/sessions/s1/events/query"],
  ])("leaves %s %s to the agent's rules", (method, path) => {
    expect(refuse(method, path)).toBeNull();
  });

  it("counts Notion's POST queries as reads and its edits as writes", () => {
    const write = (method: string, path: string) => notion.isWriteRule({ method, path });
    expect(write("GET", "/v1/pages/**")).toBe(false);
    expect(write("POST", "/v1/search")).toBe(false);
    expect(write("POST", "/v1/data_sources/*/query")).toBe(false);
    expect(write("POST", "/v1/databases/abc/query")).toBe(false);
    expect(write("POST", "/v1/blocks/meeting_notes/query")).toBe(false);
    expect(write("POST", "/v1/pages")).toBe(true);
    expect(write("PATCH", "/v1/blocks/*")).toBe(true);
    expect(write("DELETE", "/v1/blocks/*")).toBe(true);
    // A wildcard that could reach a write is a write.
    expect(write("POST", "/v1/**")).toBe(true);
    expect(write("POST", "/v1/data_sources/**")).toBe(true);
  });

  it("forwards JSON bodies only, and rewrites no URLs", () => {
    expect(notion.bodyTypes).toEqual(["application/json"]);
    expect(notion.rewritesUrls).toBe(false);
  });
});
