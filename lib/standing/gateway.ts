// Standing things (the cascading stop) are hosted-only. In Core no call is ever
// recognised as creating one, so nothing is refused, recorded or settled.
export const STANDING_TABLE = "standing_things";
export type StandingCall = never;
export function standingFor(..._args: unknown[]): { call: StandingCall | null; refusal: { code: string; message: string } | null } {
  return { call: null, refusal: null };
}
export async function recordStandingIntent(..._args: unknown[]): Promise<string | null> { return null; }
export async function settleStanding(..._args: unknown[]): Promise<null> { return null; }
export async function announceBirth(..._args: unknown[]): Promise<void> {}
export function answerJson(..._args: unknown[]): unknown { return undefined; }
