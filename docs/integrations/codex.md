# Codex

Codex reads a PassControl profile that sends its model calls to the local sidecar. The sidecar
signs each call with the agent's passport, and the gateway adds the real OpenAI key server-side.
Codex speaks only OpenAI's Responses API, so the profile always uses the OpenAI route.

## Set it up

```bash
passcontrol configure codex            # preview the profile
passcontrol configure codex --write    # write ~/.codex/passcontrol.config.toml
passcontrol sidecar                    # start it first
codex --profile passcontrol            # plain `codex` still goes straight to OpenAI
```

Codex's own `config.toml` is not touched. If Codex also keeps an OpenAI key of its own
(`auth.json`), the command says so. The PassControl profile never sends that key, but plain `codex`
does, and `codex logout` removes it.

The agent's OpenAI scope must allow the model Codex uses (`-m`, or `model` in Codex's config). To
undo, run `passcontrol configure codex --remove`.

## On a ChatGPT plan

Codex signed in with a ChatGPT plan talks to OpenAI directly, and PassControl stays out of that
path. The agent's stops and tool rules still reach the session, through two Codex hooks:

```bash
passcontrol configure codex --subscription            # preview
passcontrol configure codex --subscription --write    # adds two hooks to ~/.codex/hooks.json
passcontrol sidecar                                    # start it before Codex
```

Then open Codex, type `/hooks`, and trust PassControl's two hooks. Codex skips a hook nobody has
trusted, without saying so.

- A suspended agent, or the kill switch, blocks the next prompt and refuses tools.
- The agent's tool rules refuse what they deny. An "ask the owner" rule waits for the owner's answer.

`hooks.json` is shared with other tools. Setup adds or replaces only PassControl's entries, keeps a
backup the first time (`hooks.json.passcontrol-backup`), and
`passcontrol configure codex --subscription --remove` takes out only PassControl's entries.

What it cannot do:

- **Codex has no strict hook mode.** If the sidecar is not running, or a hook fails, Codex goes
  ahead. A missing sidecar shows a warning.
- **Only some tool rules apply.** Command rules (Bash) and MCP tool rules work. Path rules (Read,
  Write, Edit) and domain rules (WebFetch) name Claude Code's tools, which Codex does not have, so
  they do not apply here.
- **An "ask" rule cannot ask in Codex, so it refuses instead.**
- **No per-session stop.** Codex's calls are not shown on the agent's page, and a single Codex
  session cannot be stopped from the dashboard. Suspend the agent instead.

## Give it an agent of its own

```bash
passcontrol configure codex --dedicated --write
passcontrol sidecar --profile codex     # serves port 8791
```

This creates the agent "Codex @ <host>" once, scoped to `gpt-*`, and keeps its passport in a
private profile on this machine. With Claude Code set up the same way, `passcontrol sidecar
--profiles claude-code,codex` runs both from one terminal. Each then has its own budget, receipts
and kill switch.

## Sessions

Codex declares its session and thread on each call. `passcontrol sessions` lists them, and the
policy keys `subagent_session_cap_cents` and `session_alert_cents` work as they do for
[Claude Code](./claude-code.md#sessions-and-sub-agents). They are declared by the client, so they are
guard rails, not a security boundary.
