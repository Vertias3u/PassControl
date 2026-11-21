// Missions are hosted-only. Core never binds a call to a mission (lib/mission/gate.ts answers
// "none"), so these are never reached; if one were, the answer is "outside", never "inside".
import type { MissionDocument } from "./document";

export type MissionDimension = "model" | "service" | "money" | "subagents" | "window" | "tool";
export type MissionDecision =
  | { state: "inside" }
  | { state: "outside"; dimension: MissionDimension; detail: string };

const NOT_HERE = "this gateway does not operate missions";

export function missionModelDecision(_doc: MissionDocument, _provider: string, _model: string): MissionDecision {
  return { state: "outside", dimension: "model", detail: NOT_HERE };
}

export function missionServiceDecision(
  _doc: MissionDocument,
  _service: string,
  _method: string,
  _segments: readonly string[]
): MissionDecision {
  return { state: "outside", dimension: "service", detail: NOT_HERE };
}
