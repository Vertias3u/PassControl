// Core never operates missions and cannot honor a mission-bound credential.
import type { GatewayPrincipal } from "@/lib/gateway/authenticate";
import type { MissionDb, MissionRecord } from "./store";
export type CallMission =
  | { kind: "none" }
  | { kind: "bound"; record: MissionRecord; enforce: boolean }
  | { kind: "refuse"; status: number; code: string; message: string }
  | { kind: "between" };
export async function resolveCallMission(input: {
  db: MissionDb;
  principal: GatewayPrincipal;
  nowS: number;
  missionOnly?: boolean;
  readBinding?: (agentId: string) => Promise<string | null>;
}): Promise<CallMission> {
  return input.principal.kind === "passport" && input.principal.mission
    ? { kind: "refuse", status: 403, code: "mission_invalid", message: "This gateway does not operate missions." }
    : { kind: "none" };
}
