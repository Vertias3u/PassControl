// One rule for "which OpenAI container is reused", shared by the dollar-limit gate
// (lib/pricing.ts unpricedRequestOption) and the hosted-tool pricer
// (lib/providers/hosted-tools.ts). They were two copies until the 1.3.0 review;
// a container shape OpenAI adds later must change both answers at once.
import { describe, expect, it } from "vitest";
import { unpricedRequestOption } from "../lib/pricing";
import { openaiContainerTier, openaiUnknownContainer } from "../lib/providers/openai-containers";

const TOOLS: Record<string, unknown>[] = [
  { type: "code_interpreter", container: "cntr_abc" },
  { type: "code_interpreter", container: { type: "auto" } },
  { type: "code_interpreter", container: { type: "auto", memory_limit: "16g" } },
  { type: "code_interpreter", container: { type: "other" } },
  { type: "code_interpreter" },
  { type: "shell", environment: { type: "container_reference", container_id: "cntr_abc" } },
  { type: "shell", environment: { type: "container_auto", memory_limit: "64g" } },
  { type: "shell", environment: null },
  { type: "shell" },
  { type: "web_search" },
];

const tool = (i: number) => TOOLS[i] as Record<string, unknown>;

describe("reused OpenAI containers", () => {
  it.each(TOOLS)("the gate and the pricer agree on %j", (t) => {
    const body = { tools: [t] };
    expect(unpricedRequestOption("openai", body) === "container").toBe(openaiUnknownContainer(body));
  });

  it("calls a string container and a container reference unknown", () => {
    expect(openaiContainerTier(tool(0))).toBe("unknown");
    expect(openaiContainerTier(tool(5))).toBe("unknown");
  });

  it("reads the memory tier of a fresh container, defaulting to 1g", () => {
    expect(openaiContainerTier(tool(1))).toBe("1g");
    expect(openaiContainerTier(tool(2))).toBe("16g");
    expect(openaiContainerTier(tool(6))).toBe("64g");
    expect(openaiContainerTier(tool(3))).toBeNull();
    expect(openaiContainerTier(tool(9))).toBeNull();
  });
});
