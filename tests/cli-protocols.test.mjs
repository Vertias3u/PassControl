import { describe, expect, it } from "vitest";
import { compareProtocolRanges, compareProtocolSets } from "../cli/protocols.mjs";

describe("CLI protocol compatibility", () => {
  it.each([
    [{ minimum: 1, maximum: 2 }, { minimum: 1, maximum: 2 }, "compatible"],
    [{ minimum: 1, maximum: 2 }, { minimum: 2, maximum: 3 }, "update-required"],
    [{ minimum: 1, maximum: 2 }, { minimum: 1, maximum: 1 }, "partial"],
    [{ minimum: 1, maximum: 1 }, { minimum: 2, maximum: 2 }, "update-required"],
    [{ minimum: 1, maximum: 1 }, undefined, "unavailable"],
  ])("compares %o with %o", (client, server, expected) => {
    expect(compareProtocolRanges(client, server)).toBe(expected);
  });

  it("reports the least-safe result across the published protocol set", () => {
    const result = compareProtocolSets({
      control_api: { minimum: 1, maximum: 1 },
      gateway_api: { minimum: 1, maximum: 1 },
      receipt: { minimum: 2, maximum: 2 },
      agent_token: { minimum: 1, maximum: 1 },
      workspace_export: { minimum: 3, maximum: 3 },
    });
    expect(result.state).toBe("update-required");
    expect(result.checks.find((check) => check.name === "receipt")?.state).toBe("partial");
  });
});
