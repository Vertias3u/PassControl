import { describe, expect, it } from "vitest";
import { AGENT_TOKEN_PROTOCOL, RECEIPT_PROTOCOL, WORKSPACE_EXPORT_PROTOCOL } from "@/cli/protocols.mjs";
import { AGENT_TOKEN_VER } from "@/lib/crypto/jws";
import { RECEIPT_VER } from "@/lib/receipt";
import { WORKSPACE_EXPORT_SCHEMA_VERSION } from "@/lib/workspace-export";
import { SUPPORTED_VER as SDK_RECEIPT_MAX } from "@/sdk/verify";
// @ts-expect-error CLI is intentionally plain ESM, declared via .d.mts for app imports.
import { SUPPORTED_VER as CLI_RECEIPT_MAX } from "../cli/verify.mjs";

describe("protocol aliases", () => {
  it("derives every public version alias from the shared capability matrix", () => {
    expect(RECEIPT_VER).toBe(RECEIPT_PROTOCOL.maximum);
    expect(SDK_RECEIPT_MAX).toBe(RECEIPT_PROTOCOL.maximum);
    expect(CLI_RECEIPT_MAX).toBe(RECEIPT_PROTOCOL.maximum);
    expect(AGENT_TOKEN_VER).toBe(AGENT_TOKEN_PROTOCOL.maximum);
    expect(WORKSPACE_EXPORT_SCHEMA_VERSION).toBe(WORKSPACE_EXPORT_PROTOCOL.maximum);
  });
});
