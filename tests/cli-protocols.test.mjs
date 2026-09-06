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
      statement: { minimum: 1, maximum: 1 },
    });
    expect(result.state).toBe("update-required");
    expect(result.checks.find((check) => check.name === "receipt")?.state).toBe("partial");
  });

  it("calls a gateway that predates the statement protocol unavailable, not compatible", () => {
    // The accepted cost of publishing the statement format as a negotiated
    // contract. Every other range here matches exactly, so without `statement`
    // this set would be "compatible" — and a CLI that reported compatible
    // against a gateway with no statement endpoint would be lying by omission.
    // A self-hoster who upgrades the CLI before the gateway sees this, and the
    // release note says so. If this test ever goes green as "compatible",
    // someone has quietly dropped the key from CLIENT_PROTOCOLS.
    const result = compareProtocolSets({
      control_api: { minimum: 1, maximum: 1 },
      gateway_api: { minimum: 1, maximum: 1 },
      receipt: { minimum: 1, maximum: 2 },
      agent_token: { minimum: 1, maximum: 1 },
      workspace_export: { minimum: 1, maximum: 1 },
    });
    expect(result.state).toBe("unavailable");
    expect(result.checks.find((check) => check.name === "statement")?.state).toBe("unavailable");
  });
});
