export interface MemoryCustody {
  hook(input: Record<string, unknown>, options?: { client?: "claude-code" | "codex"; api?: boolean }): Promise<void>;
  /** In withhold mode: the request body with pending memory cut out, or null when unchanged. */
  modelRequest(sessionId: string, body: unknown): Promise<any>;
  fallback(sessionId: string | null | undefined, body: unknown): any;
  mode(): string;
  setView(view: unknown): void;
  state(sessionId?: string): "off" | "clear" | "held";
  review(cwd: string, client?: "claude-code" | "codex"): Promise<{ state: string; items: Record<string, unknown>[] }>;
  _debug: { sessions: Map<string, unknown>; roots: Map<string, unknown> };
}
export function createMemoryCustody(options: {
  send: (body: Record<string, unknown>) => Promise<{ status: number; body: any }>;
  env?: Record<string, string | undefined>;
  now?: () => number;
  salt?: string | null;
  onWarn?: (message: string) => void;
}): MemoryCustody;
export function workspaceRoot(cwd: string): string;
