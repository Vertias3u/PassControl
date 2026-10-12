"use server";
// Subscription mode, Phase 2: the dashboard's one tool-rules mutation.
//
//   setAgentToolRules — which Claude Code tools one agent may run on a Pro/Max login
//
// Behind MFA step-up like every credential and access mutation (service-actions.ts):
// a server action is addressable over HTTP by its id, so the page's redirect protects
// the page and not this. The rules decide what an agent may do on its owner's machine.
//
// The service-role client is used because `authenticated` has no UPDATE grant on
// `agents.tool_rules` (0085), like `service_rules`: the only writer is this validating
// action. The tenant boundary is therefore in code: the user id comes from the MFA
// gate and the write filters on it.
//
// Validated with the parser the sidecar and the gateway use (cli/tool-rules.mjs), so
// this can never store rules that would then deny every tool. The audit row holds
// counts, never a command, path or domain: admin_audit is tenant-readable and served
// by the control API, and the patterns can name private hosts and files.
import { revalidatePath } from "next/cache";

import { DEFAULT_APPROVAL_WAIT_S, TOOL_RULE_LIMITS, parseToolRules, type ToolRule } from "@/cli/tool-rules.mjs";
import { recordAdminAction } from "@/lib/audit";
import { mfaAuthorizedUser } from "@/lib/mfa";
import { serviceClient } from "@/lib/supabase";
import { userClient } from "@/lib/supabase/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ToolRulesActionState {
  ok?: boolean;
  error?: string;
  notice?: string;
}

export interface ToolRuleInputRow {
  tool: string;
  effect: string;
  command?: string;
  path?: string;
  domain?: string;
}

const RULE_HELP =
  "A tool is a name such as Bash, Read or mcp__github__create_issue, or a prefix ending in * (no condition then). A command is for Bash, a path for Read, Edit, MultiEdit, Write, NotebookEdit, Glob or Grep (starting with / or a drive letter, or with *), and a domain for WebFetch (example.com or *.example.com). Use * for any run of characters.";

export async function setAgentToolRules(
  agentId: string,
  input: { rules: ToolRuleInputRow[]; approvalWaitS: number | null }
): Promise<ToolRulesActionState> {
  if (!UUID_RE.test(agentId ?? "")) return { error: "That agent could not be found." };

  // The stored shape: each rule's own fields, an empty condition left out.
  const rows = Array.isArray(input?.rules) ? input.rules : [];
  if (rows.length > TOOL_RULE_LIMITS.rules) return { error: `At most ${TOOL_RULE_LIMITS.rules} rules.` };
  const candidates = rows.map((row) => {
    const rule: Record<string, unknown> = { tool: String(row?.tool ?? "").trim(), effect: String(row?.effect ?? "") };
    for (const kind of ["command", "path", "domain"] as const) {
      const value = typeof row?.[kind] === "string" ? row[kind]!.trim() : "";
      if (value) rule[kind] = value;
    }
    return rule;
  });
  // Checked one at a time first, so the error names the rule.
  for (const [index, rule] of candidates.entries()) {
    if (!parseToolRules({ rules: [rule] }).ok) return { error: `Rule ${index + 1} is not valid. ${RULE_HELP}` };
  }
  const wait = input?.approvalWaitS;
  if (
    wait !== null &&
    wait !== undefined &&
    (!Number.isInteger(wait) || wait < TOOL_RULE_LIMITS.minWaitS || wait > TOOL_RULE_LIMITS.maxWaitS)
  ) {
    return { error: `The wait for your answer is a whole number of seconds between ${TOOL_RULE_LIMITS.minWaitS} and ${TOOL_RULE_LIMITS.maxWaitS}.` };
  }
  const document: Record<string, unknown> = { rules: candidates };
  if (wait !== null && wait !== undefined && wait !== DEFAULT_APPROVAL_WAIT_S) document.approval_wait_s = wait;
  const parsed = parseToolRules(document);
  if (!parsed.ok) return { error: `These rules are not valid. ${RULE_HELP}` };
  const stored = parsed.rules.length === 0 ? null : { ...document, rules: parsed.rules };

  const db = await userClient();
  const gate = await mfaAuthorizedUser(db);
  if (!gate.ok) {
    return {
      error:
        gate.reason === "step_up_required"
          ? "Complete two-factor verification before changing credentials or access."
          : gate.reason === "unauthenticated"
            ? "Sign in again to change credentials or access."
            : "Your authentication assurance could not be verified. Try again.",
    };
  }
  const userId = gate.user.id;

  const { data: updated, error } = await serviceClient()
    .from("agents")
    .update({ tool_rules: stored })
    .eq("id", agentId)
    .eq("user_id", userId)
    .select("id");
  if (error) {
    const code = String((error as { code?: unknown }).code ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "unknown";
    console.error("[dashboard:setAgentToolRules]", code);
    if (code === "42703") return { error: "This deployment has not applied migration 0085, so tool rules cannot be saved yet." };
    return { error: "Something went wrong. Please try again." };
  }
  if (!Array.isArray(updated) || updated.length !== 1) return { error: "That agent could not be found." };

  const by = (effect: ToolRule["effect"]) => parsed.rules.filter((rule) => rule.effect === effect).length;
  await recordAdminAction({
    userId,
    action: "agent.tool_rules",
    targetType: "agent",
    targetId: agentId,
    metadata: {
      rules: parsed.rules.length,
      deny: by("deny"),
      ask: by("ask"),
      ask_owner: by("ask_owner"),
      approval_wait_s: parsed.approvalWaitS,
    },
  });
  revalidatePath(`/dashboard/agents/${agentId}`);
  return {
    ok: true,
    notice:
      parsed.rules.length === 0
        ? "This agent has no tool rules now: Claude Code's own permissions decide."
        : "Saved. The sidecar picks these up within a few seconds, at the next tool call.",
  };
}
