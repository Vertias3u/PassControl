# Demos

Five recordings, each one making a single claim you can check rather than a
feature tour. They exist because the interesting thing about this project is not
what the dashboard looks like — it is what the gateway refuses to do.

| Script | The claim |
|---|---|
| `kill-demo.sh` | Subsequent calls from a running agent are blocked and restored, without rotating a provider key. |
| `budget-demo.sh` | The budget is part of the authorization decision, so an admission refusal does not dispatch a provider call. |
| `scope-demo.sh` | The agent's authority is narrower than the key it never holds. |
| `receipt-demo.sh` | A receipt verifies for someone with no account and no credentials here. |
| `portability-demo.sh` | Two unrelated clients, one identity, one policy, no SDK change. |

## Recording

The demo scripts require bash, curl and their script-specific utilities (including Node and jq); on Windows use a bash environment such as Git Bash. They are not PowerShell scripts.

[vhs](https://github.com/charmbracelet/vhs) turns a `.tape` into a GIF:

```
cd docs/demo
vhs budget.tape        # → budget.gif
```

`Sleep` in each tape is wall-clock and must outlast the script, or the recording
stops mid-run. The values assume a warm gateway; add seconds if yours is cold.

## What each one needs first

All of them need a gateway you can reach and an agent that can call it. Nothing
here creates state — a demo that silently reconfigures your fleet to make itself
look good is not a demo.

- **Everything except `receipt-demo.sh`** goes through the sidecar. Start it and
  leave it running: `passcontrol sidecar`. Budget, scope and portability demos read
  the `SIDECAR` environment variable; the kill demo fixes its listener at port 8788.
- **`budget-demo.sh`** needs an agent whose *remaining* budget is small enough to
  exhaust within its bounded call loop. Use a disposable agent with known usage and
  a small remaining cap. Do not seed `agents.spent_microcents` alone: admission
  uses Redis counters, holds and durable generations, so editing one mirror column
  does not establish a coherent budget. Prefer a token cap for a short demonstration.
  The recorded example used seeded spend; it is not evidence of fresh-install defaults.
  See [budget recovery](../budget-recovery.md) before changing accounting state.
- **`scope-demo.sh`** needs the agent scoped to one model. It reads the scope and
  prints it first, so the refusal that follows is visibly a policy decision and
  not a typo. Override with `ALLOWED_MODEL=` / `DENIED_MODEL=`. That first line
  is read from the control plane and matched on `PASSPORT_ID`, so it needs
  `PASSCONTROL_API_KEY` too — `budget-demo.sh` reads its spend the same way.
  Without the key both say so rather than printing a confident blank.
- **`receipt-demo.sh`** talks to the control plane directly, so it needs
  `PASSCONTROL_API_KEY` and `PASSCONTROL_GATEWAY` — it will source a
  `.passcontrol` file from the working directory if there is one. It also needs
  the instance to be signing: no `INSTANCE_SIGNING_KEY` means no receipt, and the
  script says that plainly instead of failing obscurely.
- **`portability-demo.sh`** runs the CLI and a raw HTTP client. It does not read a
  `HERMES` switch; testing a real framework requires running that client separately.

## A note on honesty

Each script ends by saying what its demo does *not* prove. `receipt-demo.sh` is
the important one: a receipt attests what the enforcement layer observed and
decided. It is not a claim about whether the model's answer was any good, and it
carries no prompt or completion by design — the evidence should not become
another copy of your sensitive content.

`receipt-demo.sh` and the CLI leg of `portability-demo.sh` use the direct CLI call path, so they need sender-proof mode off/observe
today. It samples the latest log row rather than correlating a request ID; use an
isolated demo agent with no concurrent traffic and allow for asynchronous log writes.
A failed/missing receipt can mean logging/signing failure, not just absent configuration.
The scripts are demonstrations, not reliable billing or receipt-correlation clients.
