// Core has no mission-only agents. No database or cache lookup is needed.
export function missionOnlyOf(_snapshot: { policy?: unknown; missionOnly?: boolean }, _failClosed: boolean): boolean | "unknown" { return false; }
export const MISSION_UNAVAILABLE_MESSAGE = "This gateway does not operate missions.";
