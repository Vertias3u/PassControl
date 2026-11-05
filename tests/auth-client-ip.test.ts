import { afterEach, expect, it, vi } from "vitest";
import { clientIp, clientIpFrom } from "@/lib/http/client-ip";
afterEach(() => vi.unstubAllEnvs());

it.each([
  ["true", { "cf-connecting-ip": "203.0.113.1", "x-forwarded-for": "forged" }, "203.0.113.1"],
  ["false", { "cf-connecting-ip": "203.0.113.1", "x-forwarded-for": "forged" }, "forged"],
  ["false", { "x-forwarded-for": " 198.51.100.1, 203.0.113.2" }, "198.51.100.1"],
  ["false", { "x-real-ip": " 203.0.113.3 " }, "203.0.113.3"],
  ["false", {}, "unknown"],
])("selects client IP with trust=%s and headers=%j", (trust, incoming, expected) => {
  vi.stubEnv("PASSCONTROL_TRUST_CF_CONNECTING_IP", trust);
  vi.stubEnv("VERCEL", "0");
  const headers = new Headers(incoming as Record<string, string>);
  expect(clientIpFrom(headers)).toBe(expected);
  expect(clientIp(new Request("https://gw.example", { headers }))).toBe(expected);
});
