import { describe, expect, it } from "vitest";
import { unpricedRequestOption } from "@/lib/pricing";
import { serverSideToolUse } from "@/lib/providers/server-side-tools";
import { canonicalEndpointPath } from "@/lib/scope";
import codexRequest from "./fixtures/codex/responses-request.json";

// What Codex actually sends through `passcontrol configure codex` (1.3.0 #5),
// captured from Codex CLI 0.160.1 with a real user config under it: its own
// functions, two namespaces of functions, and OpenAI's hosted web search. If the
// gateway refused any one of these, every Codex turn would fail, so the shape is
// pinned rather than assumed.
describe("a real Codex request passes the OpenAI rules", () => {
  it("reaches the Responses endpoint at the address the profile writes", () => {
    // Codex appends `/responses` to the profile's base_url, `/api/v1/openai`.
    expect(canonicalEndpointPath("openai", "POST", ["responses"])).toEqual(["v1", "responses"]);
  });

  it("uses only tools the gateway runs or prices", () => {
    expect(serverSideToolUse("openai", codexRequest)).toBeNull();
  });

  it("asks for nothing the price table cannot price", () => {
    expect(unpricedRequestOption("openai", codexRequest)).toBeNull();
  });
});
