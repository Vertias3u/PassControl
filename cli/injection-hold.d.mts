import type { ToolRuleVerdict } from "./tool-rules.mjs";

export type TaintVerdict = ToolRuleVerdict | { effect: "ask_owner"; reason: "injection_taint" };

export const INJECTION_HOLD_TOOLS: ReadonlySet<string>;
export function heldUnderTaint(toolName: unknown): boolean;
export function underTaint<V extends ToolRuleVerdict>(verdict: V, toolName: unknown): V | { effect: "ask_owner"; reason: "injection_taint" };
