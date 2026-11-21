export type ShellClass =
  | "inspect" | "build" | "vcs_local" | "process" | "fs_mutate" | "container" | "network" | "opaque" | "vcs_push" | "rm_rf";
export type ToolItem =
  | { kind: "workspace"; root: string; write: boolean }
  | { kind: "shell"; class: string }
  | { kind: "host"; host: string; via: "web" | "browser" | "shell" }
  | { kind: "tool"; name: string }
  | { kind: "memory_write" };
export const SHELL_CLASSES: readonly ShellClass[];
export const NEVER_LEARNED: ReadonlySet<string>;
export const HOST_VIA: readonly ("web" | "browser" | "shell")[];
export const INTERNAL_TOOLS: ReadonlySet<string>;
export function validRoot(root: unknown): boolean;
export function normalisePath(path: unknown): string | null;
export function within(root: string, path: string): boolean;
export function normaliseHost(raw: unknown): string | null;
export function parseToolItem(item: unknown): ToolItem | null;
export function toolItemContains(outer: ToolItem | null | undefined, inner: ToolItem | null | undefined): boolean;
export function toolItemKey(item: ToolItem): string;
export function shellClassOf(word: unknown): ShellClass;
export function classifyShell(command: unknown): ToolItem[];
export function itemsForToolCall(input: unknown): ToolItem[];
export function internalItem(item: ToolItem): boolean;
export function evaluateMissionTools(
  missionTools: readonly ToolItem[],
  input: unknown
): { state: "inside" | "outside"; missing: ToolItem[] };
