// "Ask me first": the fingerprint decides what one approval admits, so every
// part of the request the gateway forwards must move it.
import { describe, expect, it } from "vitest";

import { approvalFingerprint, approvalPreview, type FingerprintInput } from "@/lib/approvals/fingerprint";

const base = (): FingerprintInput => ({
  userId: "u1",
  agentId: "a1",
  service: "discord",
  method: "POST",
  upstreamPath: "/v10/channels/1/messages",
  search: "",
  headers: new Headers({ "content-type": "application/json" }),
  body: '{"content":"hello"}',
});

describe("the approval fingerprint", () => {
  it("is stable for the same request, and ignores header order and name case", async () => {
    const a = await approvalFingerprint(base());
    const b = await approvalFingerprint({
      ...base(),
      headers: new Headers([["Content-Type", "application/json"]]),
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each<[string, Partial<FingerprintInput>]>([
    ["body", { body: '{"content":"@everyone"}' }],
    ["query", { search: "?wait=true" }],
    ["path", { upstreamPath: "/v10/channels/2/messages" }],
    ["method", { method: "PATCH" }],
    ["a forwarded header", { headers: new Headers({ "content-type": "application/json", "notion-version": "2022-06-28" }) }],
    ["agent", { agentId: "a2" }],
    ["workspace", { userId: "u2" }],
    ["service", { service: "notion" }],
    ["a missing body", { body: null }],
  ])("changes with the %s", async (_name, change) => {
    expect(await approvalFingerprint({ ...base(), ...change })).not.toBe(await approvalFingerprint(base()));
  });

  it("previews the query and the whole body, unaltered", () => {
    expect(approvalPreview('{"content":\n"hi"}', "?wait=true")).toBe('?wait=true\n{"content":\n"hi"}');
    expect(approvalPreview(null, "")).toBe("");
  });
});
