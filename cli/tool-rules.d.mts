export type ToolRuleEffect = "deny" | "ask_owner" | "ask";
export interface ToolRule {
  tool: string;
  effect: ToolRuleEffect;
  command?: string;
  path?: string;
  domain?: string;
}
export type ParsedToolRules = { ok: true; rules: ToolRule[]; approvalWaitS: number } | { ok: false };
export interface ToolRuleInput {
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
}
export type ToolRuleVerdict = { effect: null } | { effect: ToolRuleEffect; ruleIndex: number; subject: string };

export const TOOL_RULE_EFFECTS: readonly ToolRuleEffect[];
export const DEFAULT_APPROVAL_WAIT_S: number;
export const TOOL_RULE_LIMITS: {
  rules: number;
  patternLen: number;
  toolLen: number;
  minWaitS: number;
  maxWaitS: number;
};
export function globMatch(pattern: string, text: string): boolean;
export function parseToolRules(value: unknown): ParsedToolRules;
export function evaluateToolRules(parsed: { rules: ToolRule[] }, input: ToolRuleInput): ToolRuleVerdict;
