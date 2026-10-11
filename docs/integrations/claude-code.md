# Claude Code

Claude Code's model calls go through PassControl's local sidecar. The sidecar holds the agent's
passport and signs for every call. Claude Code itself never holds a provider key or a passport
secret. Each call then passes the agent's scope, budget, policy and kill switch, and gets a
signed receipt.

## Set it up

```bash
passcontrol configure claude-code            # preview the two settings it would write
passcontrol configure claude-code --write    # this project (.claude/settings.local.json)
passcontrol configure claude-code --write --global   # every session (~/.claude/settings.json)
passcontrol sidecar                          # start it before Claude Code
```

Two settings are written: `ANTHROPIC_BASE_URL` (the sidecar's Anthropic route) and
`ANTHROPIC_AUTH_TOKEN` (a placeholder, which the sidecar replaces). If the file also holds a raw
`ANTHROPIC_API_KEY`, the command warns you. Remove that key, because nothing needs it there any
more.

The agent's Anthropic scope must allow every model Claude Code uses: its main model, and Haiku,
which it uses for small tasks. Add `--statusline` to show the agent's remaining budget in Claude
Code's status line. To undo, run `passcontrol configure claude-code --remove` (add `--global` if
you wrote it there).

## `/passcontrol` inside Claude Code

```bash
claude plugin install passcontrol --marketplace Vertias3u/PassControl
```

Type `/passcontrol` to see the agent's limits, what is left, and a link to its dashboard page.
The plugin answers on your machine and never calls the model, so it also works while the gateway
is refusing calls. It then says so: a session its owner stopped, a suspended agent or the kill
switch, or a spent limit. Claude Code shows the answer under "Operation stopped by hook", its label
for an answer that did not go to the model.

It reads through the sidecar that Claude Code's `ANTHROPIC_BASE_URL` names, so a dedicated agent's
sidecar is the one asked. The plugin is MIT and needs the CLI. Remove it with
`claude plugin uninstall passcontrol`.

## Give it an agent of its own

By default Claude Code shares the machine's passport with every other tool on the sidecar. To
give it its own agent, with its own budget, scope, receipts and kill switch:

```bash
passcontrol configure claude-code --dedicated --write
passcontrol sidecar --profile claude-code     # serves port 8790
```

This creates the agent "Claude Code @ <host>" once, scoped to `claude-*`, and keeps its passport
in a private profile on this machine. Set its budget on its dashboard page. Running it again reuses that agent. With Codex set up the same way, `passcontrol
sidecar --profiles claude-code,codex` runs both from one terminal. `passcontrol profile list`
shows the profiles. Creating the agent needs the control-plane API key that `passcontrol login`
saves.

## Sessions and sub-agents

Claude Code tells the gateway which session, and which sub-agent, each call belongs to. PassControl
records this as **declared** lineage: the client says it, and nothing proves it.
- `passcontrol sessions` lists the sessions. The agent's dashboard page shows each one's spend,
  and can stop a single session without suspending the agent.
- `passcontrol seal <session> --agent <id>` signs one session's record, with its receipts.
- In the agent's policy, `subagent_session_cap_cents` caps how much any one sub-agent may spend
  in a session (402 `blocked_budget_subagent`). `session_alert_cents` sends one workspace alert
  when a session passes that amount. The alert pauses nothing.

Because a client chooses its own session and sub-agent ids, these are guard rails for an honest
client. They are not a security boundary. The agent's own budget, scope and kill switch are.
