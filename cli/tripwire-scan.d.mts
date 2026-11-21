export interface DecoyCandidates {
  candidates: string[];
  truncated: boolean;
}
export const TRIPWIRE_SCAN_LIMITS: Readonly<{
  maxCandidates: number;
  maxDepth: number;
  streamWindow: number;
  streamTail: number;
  seam: number;
}>;
/** A credential header's value, plus its decoded HTTP Basic credentials when it is Basic auth. */
export function credentialHeaderTexts(raw: unknown): string[];
export function findDecoyCandidates(text: string): DecoyCandidates;
export function candidatesInJson(value: unknown): DecoyCandidates & { gaps: ("depth_limit" | "candidate_limit")[] };
export function createStreamCandidateFinder(): {
  push(fragment: string): void;
  finish(): DecoyCandidates;
  retained(): number;
};
