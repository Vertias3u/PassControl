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

## On a Claude Pro or Max subscription

The setup above uses an API key that the gateway holds. If you sign in to Claude Code with your
own Pro or Max plan, keep doing that. PassControl does not sit between Claude Code and Anthropic
and never sees your login: Anthropic's terms do not allow a third party to handle it, and nothing
here needs it. Instead, Claude Code reports to the sidecar and asks it before it acts:

```bash
passcontrol configure claude-code --subscription            # preview
passcontrol configure claude-code --subscription --write    # your user settings (~/.claude/settings.json)
passcontrol sidecar
passcontrol watch                                           # each call as Claude Code reports it
```

What you get:
- **One stop.** Before each prompt, before each tool, and before the next model call in a turn,
  Claude Code asks the sidecar. If the agent is suspended, the kill switch is on, or its owner
  stopped this session, the turn ends with the reason. This works through Claude Code's hooks,
  inside Claude Code. It is a guard rail for your own sessions, not a boundary against a client
  that skips them.
- **Every call on the board.** Claude Code's own telemetry sends each model call to the sidecar,
  and `watch` shows it as `SEEN` with its model, session, sub-agent, time, and what it would have
  cost on the API. That cost is shown only, never charged to a budget, because your plan is a flat
  fee. The sidecar keeps an allowlist of fields, so your email and account ids, which Claude Code
  attaches to every event, are dropped before anything is shown.
- **The same calls on the agent's page.** The sidecar also uploads them to the gateway, as the
  agent, and the agent's dashboard page lists them under "Reported by Claude Code". They are kept
  apart from proxied calls: not proxied, no receipt, and the cost is API-equivalent and never
  charged. Each is sent with its own key, so a retry never counts a call twice. A suspended or
  killed agent's reports are not recorded. They are kept for 90 days (on a self-hosted gateway,
  older ones go the next time that agent uploads). To keep them on this machine only, start the sidecar
  with `--no-report-calls`. A gateway from before this feature (no endpoint, or no migration 0084)
  cannot store them: the sidecar then drops them, waits ten minutes before trying again, and
  nothing else changes.
- **Tool rules.** On the agent's dashboard page, under "Claude Code tool rules", say which tools
  this agent may run: refuse a tool, hand it to Claude Code's own prompt ("Ask in the terminal"),
  or hold it until you say yes ("Ask me first"). A rule names a tool and, for some tools, a
  condition: a command for `Bash` (`git push*`), a path for the file tools (`/Users/me/.ssh/*`), or
  a domain for `WebFetch` (`*.example.com`). MCP tools are named like `mcp__github__create_issue`,
  and `mcp__github__*` covers a whole server. `*` matches anything. A `Bash` rule is checked
  against each command in a chain, so `git push*` also catches `cd repo && git push`. The strictest
  matching rule wins, and a tool no rule names is left to Claude Code's own permissions, which
  still apply after a rule lets a tool through. "Ask me first" sends the tool's whole input (the command, the file path and any content being
  written, the address, or an MCP tool's arguments) to your Telegram, Slack or Discord and to the
  Approvals page; the tool waits (120 s
  unless you set otherwise, at most 540) and runs only after your yes. No answer in time means it
  does not run. The decisions are listed on the agent's page under "Tool rules at work": the
  tool's name and the decision, never the command. The sidecar picks up a change within a few
  seconds. If you set up subscription mode before tool rules existed, run `passcontrol configure
  claude-code --subscription --write` again: the old hook gave up after 5 s, so "Ask me first"
  refuses under it rather than let a tool run unanswered. If the sidecar cannot read the rules
  (the gateway is down), tools go ahead with a warning, as stops do. Like stops, the rules work
  inside Claude Code: a guard rail for your own sessions, not a boundary against a client that
  skips its hooks.
- **Your usage window.** The status line, `watch` and `/passcontrol` show how much of the 5-hour
  and 7-day allowance is used (`5h 24% · 7d 41%`), as Claude Code reports it after the first
  answer. This is also shown only. Anthropic enforces its own window.

If the sidecar is not running, Claude Code still works. Stops are not checked and calls are not
shown until it is, and Claude Code shows a "hook error" notice (connection refused) on each
prompt and tool. Because the settings are your user settings, that applies in every project. The
command writes your user settings because Claude Code ignores telemetry settings in a project's
file. It keeps anything of yours, and it refuses to redirect a log export you already send
elsewhere unless you add `--force`. To undo, run `passcontrol configure claude-code --subscription --remove`.

## Tell the agent its own limits (opt-in)

Add `--agent-note` to either setup, and on a prompt Claude Code is told about its own limits, so
it can plan the work before it is refused:

```sh
passcontrol configure claude-code --write --agent-note                  # through the sidecar
passcontrol configure claude-code --subscription --write --agent-note   # on a Pro or Max plan
```

> PassControl budget note (sent when it changes): $5.00 of $20.00 left today; it resets at
> 00:00. At this rate it runs out at 16:00.

The note is sent only when something in it changes: another quarter of the budget used (and at
90 %), the reset less than an hour away, the rate turning to reach the limit before the reset or
away from it, or the tool rules changing. It costs the session almost no context. "At this rate"
comes from the gateway: what a daily or monthly limit has counted so far this period, or for a
limit with no period, the last 24 hours of spend.

On a Pro or Max plan the note leads with the agent's tool rules, which apply there, because the
plan's own calls never count against a PassControl budget. Any budget it mentions is named for
what it covers: calls made through PassControl. It is off unless you add the flag, and running
the command again without it takes it off.

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
sidecar is the one asked. On a subscription it uses the sidecar that `--subscription` set up, and
also shows the usage window. The plugin is MIT and needs the CLI. Remove it with
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
