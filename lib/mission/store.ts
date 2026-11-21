// Core has no hosted mission store. Shared callers receive no active mission.
import type { MissionDocument } from "./document";
export type MissionStatus = "draft" | "active" | "completed" | "revoked" | "expired";
export type MissionMode = "shadow" | "enforce";

export interface MissionRecord {
  id: string;
  userId: string;
  agentId: string;
  status: MissionStatus;
  mode: MissionMode;
  rootHash: string;
  currentHash: string;
  revision: number;
  document: MissionDocument;
  ledgerId: string | null;
}

export type MissionRead =
  | { kind: "ok"; record: MissionRecord }
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "unavailable" };


export type MissionDb = { from: (table: string) => unknown };
export async function readActiveMissionForAgent(..._args: unknown[]): Promise<MissionRead> { return { kind: "none" }; }
export async function readMissionById(..._args: unknown[]): Promise<MissionRead> { return { kind: "none" }; }
export function missionInForce(_record: MissionRecord, _nowS: number): boolean { return false; }
