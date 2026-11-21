export const PARSER_VERSION: number;
export interface MemoryEntry { text: string; scope: string[]; digest: string; occurrence: number; start: number; end: number }
export interface OutsideMark { kind: "web" | "mcp" | "shell_network" | "outside_read" | "workspace_read" | "memory_arrival"; host?: string }
export function sha256Hex(text: string): string;
export function hmacHex(saltHex: string, text: string): string;
export function memoryEntries(raw: string): MemoryEntry[];
export function fileKey(salt: string, fileId: string): string;
export function entryKeys(salt: string, fileId: string, entries: MemoryEntry[]): string[];
export function saltFingerprint(salt: string, version?: number): string;
export function diffKeys(prev: readonly string[], next: readonly string[]): string[];
export function isLoopbackHost(host: string): boolean;
export function bashNetworkSource(command: unknown): string | null;
export function normalizePath(p: string, cwd?: string): string;
export function outsideMarks(
  event: { tool_name?: unknown; tool_input?: unknown },
  ctx?: { cwd?: string; outsideReads?: boolean; localRoots?: string[]; workspaceTrust?: "own" | "third_party" }
): OutsideMark[];
export function requestMemorySections(body: unknown): { path: string; text: string }[];
export const WITHHELD_ENTRY: (n: number) => string;
export const WITHHELD_LINE: string;
export function withholdRequest(
  body: unknown,
  options: { decide: (section: { path: string; entries: MemoryEntry[] }) => Set<number> | "all" | null | undefined; stripLines?: string[]; probes?: string[] }
): { body: any; sectionsChanged: number; entriesWithheld: number; linesWithheld: number; residue: number };
