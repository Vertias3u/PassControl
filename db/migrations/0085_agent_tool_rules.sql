-- ============================================================================
-- PassControl — an agent's tool rules (subscription mode, Phase 2).
--
-- A Claude Pro/Max session runs its tools on the user's machine, where the gateway
-- cannot see them. Claude Code's PreToolUse hook asks the local sidecar first, and
-- the sidecar answers from these rules: deny a tool, hand it to Claude Code's own
-- prompt, or wait for the owner's yes (plans/subscription-mode.md, Phase 2 design).
--
--   agents.tool_rules — {"rules": [{"tool": "Bash", "command": "git push*",
--                        "effect": "ask_owner"}, …], "approval_wait_s": 120}
--
-- A column of its own, NOT a key under `policy`: the policy parser refuses the whole
-- policy on a key it does not know, so an older gateway would refuse every model
-- call of an agent whose policy held tool rules. Here an older gateway simply never
-- reads them.
--
-- Shaped, not validated: an object, bounded in size. The rule language is checked by
-- whoever reads it (cli/tool-rules.mjs, shared by the sidecar and the gateway); a
-- document it does not understand refuses that agent's tools.
--
-- ── Grants ────────────────────────────────────────────────────────────────
--
-- None added. `authenticated` holds table-level SELECT on agents, which covers the
-- column; its UPDATE is column-level (0011, 0018, 0073) and does not include it.
-- Like `service_rules` (0074), it is written only by a server action that validates
-- it, so a browser session cannot PATCH it directly.
--
-- Additive. Old code ignores it.
-- ============================================================================

alter table public.agents
  add column if not exists tool_rules jsonb;

alter table public.agents
  drop constraint if exists agents_tool_rules_object,
  add constraint agents_tool_rules_object
    check (tool_rules is null or jsonb_typeof(tool_rules) = 'object'),
  -- A bound, not a format. 100 rules of 300-character patterns fit well inside it.
  drop constraint if exists agents_tool_rules_size,
  add constraint agents_tool_rules_size
    check (tool_rules is null or pg_column_size(tool_rules) <= 131072);

comment on column public.agents.tool_rules is
  'Subscription-mode tool rules, read by the sidecar from the PreToolUse hook: {"rules": [{"tool": "Bash", "command": "git push*", "effect": "deny|ask|ask_owner"}], "approval_wait_s": 120}. Validated on every read (cli/tool-rules.mjs); a document it does not understand refuses that agent''s tools.';
