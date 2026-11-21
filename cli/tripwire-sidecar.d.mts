export const TRIPWIRE_PATH: string;
export const TRIPWIRE_SOURCE: string;
export const HEARTBEAT_MS: number;
export function decoyInHeaders(headers: Record<string, unknown>, digests: Set<string>, isCredentialHeader: (name: string) => boolean): string | null;
export function decoysInHook(input: unknown, digests: Set<string>): string[];
export function createTripwireReporter(input: { send(body: unknown): Promise<{ status: number }>; now?: () => number }): {
  used(digest: string, tools?: string[]): Promise<{ status: number }>;
  seen(digests: string[]): Promise<{ status: number }>;
  heartbeat(): Promise<{ status: number }>;
};
