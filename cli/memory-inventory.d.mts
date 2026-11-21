export const FILE_LIMIT_BYTES: number;
export const TOTAL_LIMIT_BYTES: number;
export const MAX_FILES: number;
export const LABELS: string[];
export function custodySalt(options?: { env?: Record<string, string | undefined> }): string;
export function workspaceRoot(cwd: string): string;
export function claudeProjectDirName(root: string): string;
export function importsOf(text: string): string[];
export interface MemoryFile { id: string; label: string; path: string }
export function memoryFiles(options: { cwd: string; agent?: "claude-code" | "codex"; env?: Record<string, string | undefined>; ownerPaths?: string[]; touchedDirs?: string[]; touchedFiles?: string[] }): { root: string; files: MemoryFile[]; overflow: boolean; truncated: boolean };
export interface ScannedFile { id: string; label: string; path: string; fileKey: string; keys: string[]; entries: { key: string; text: string; scope: string[] }[]; bytes: number; link: boolean }
export interface Scan { root: string; workspace: string; saltFp: string; files: ScannedFile[]; errors: { id: string; label: string; reason: string }[] }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scanMemory(options: { salt: string; cwd: string; agent?: "claude-code" | "codex"; env?: Record<string, string | undefined>; ownerPaths?: string[]; touchedDirs?: string[]; touchedFiles?: string[] }): any;
export function scanKeys(scan: Scan): string[];
