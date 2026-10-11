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
