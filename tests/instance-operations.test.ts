import { describe, expect, it } from "vitest";
import {
  buildCloudSupportBundle,
  cloudOperationsNeedsAttention,
} from "@/lib/cloud-operations";

const signals = {
  providerCredentials: "configured" as const,
  receiptSigning: "configured" as const,
  observability: "missing" as const,
  agentRegistry: "available" as const,
  activityLog: "available" as const,
};

describe("instance operations without a hosted allowance", () => {
  it("uses only Core health signals when no hosted quota exists", () => {
    expect(cloudOperationsNeedsAttention(null, signals)).toBe(false);
    expect(
      cloudOperationsNeedsAttention(null, { ...signals, receiptSigning: "missing" }),
    ).toBe(true);
    expect(
      cloudOperationsNeedsAttention(null, { ...signals, activityLog: "unavailable" }),
    ).toBe(true);
  });

  it("builds a support bundle with no hosted quota fields", () => {
    const bundle = buildCloudSupportBundle({
      generatedAt: "2026-08-30T00:00:00.000Z",
      quota: null,
      signals,
      controls: { workspaceKillArmed: false, platformKillArmed: false },
      agents: [],
      logs: [],
    });

    expect(bundle).not.toHaveProperty("quota");
    expect(bundle.service_health).not.toHaveProperty("quota_counter");
    expect(bundle.service_health).toMatchObject({
      agent_registry: "available",
      activity_log: "available",
    });
  });
});
