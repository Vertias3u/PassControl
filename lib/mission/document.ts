// Missions are hosted-only. Core never parses, signs or enforces a mission (lib/mission/gate.ts
// answers "none"); this type exists only so shared gateway code that names it still compiles.
export interface MissionDocument {
  readonly expires: number;
  readonly money: number;
  readonly tools: readonly unknown[];
}
