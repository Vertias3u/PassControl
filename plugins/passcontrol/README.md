# PassControl for Claude Code

`/passcontrol` shows this agent's PassControl budget and status inside Claude Code, and
says why its calls are refused when they are.

```
❯ /passcontrol
  Operation stopped by hook: PassControl · agent 18eddeb0

    Today       $0.42 of $10.00 · $9.58 left · resets in 7h
    Calls       through the sidecar on :8788

    Agent page  http://localhost:3000/dashboard/agents/18eddeb0-…
```

It is answered on your machine and never calls the model, so it works even while the
gateway is refusing every call: a stopped session, a suspended agent, the kill switch,
or a spent limit. "Operation stopped by hook" is Claude Code's label for an answer that
did not go to the model.

## Install

```
claude plugin install passcontrol --marketplace Vertias3u/PassControl
```

It needs the PassControl CLI (`npm install -g passcontrol`) and Claude Code sending its
calls through the PassControl sidecar (`passcontrol configure claude-code`). Remove it
with `claude plugin uninstall passcontrol`, and the listing it came from with
`claude plugin marketplace remove passcontrol`.

## What it does, and does not do

- It runs `passcontrol statusline --panel` and shows what that prints. Everything it
  knows comes from the gateway, through the sidecar.
- It passes the CLI the id of this Claude Code session, so a session its owner stopped
  is reported as stopped. It sends nothing else anywhere.
- It enforces nothing. The gateway does, whether or not this plugin is installed.

## License

MIT, unlike the rest of this repository (BSL 1.1). See [LICENSE](./LICENSE).
