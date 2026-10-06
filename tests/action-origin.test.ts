import { describe, expect, it } from "vitest";

import { originFromHeaders } from "@/lib/alerts/origin";

describe("originFromHeaders", () => {
  it("uses the Origin a server action arrives with", () => {
    expect(originFromHeaders(new Headers({ origin: "https://passcontrol.example", host: "other.example" }))).toBe(
      "https://passcontrol.example"
    );
  });

  it("falls back to the host over https", () => {
    expect(originFromHeaders(new Headers({ host: "passcontrol.example" }))).toBe("https://passcontrol.example");
  });

  it.each([
    ["a non-http Origin", { origin: "javascript:alert(1)" }],
    ["an Origin with a path", { origin: "https://passcontrol.example/evil" }],
    ["a host with a path", { host: "passcontrol.example/evil" }],
    ["a host with userinfo", { host: "user@passcontrol.example" }],
    ["nothing", {}],
  ])("returns null for %s", (_label, values) => {
    expect(originFromHeaders(new Headers(values as Record<string, string>))).toBeNull();
  });
});
