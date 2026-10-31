export type InjectionFamily = "role_markup" | "instruction_override" | "exfil_directive" | "authority_claim" | "hidden_text";
export type InjectionSeverity = "high" | "low";
export interface InjectionHit {
  family: InjectionFamily;
  severity: InjectionSeverity;
}

export const INJECTION_DETECTOR: "pc-heuristic-1";
export const INJECTION_NORMALIZATION: 1;
export const INJECTION_FAMILIES: readonly InjectionFamily[];
export function scanText(raw: string): InjectionHit[];
