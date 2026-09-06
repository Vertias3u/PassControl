# Demos

Five recordings, each one making a single claim you can check rather than a
feature tour. They exist because the interesting thing about this project is not
what the dashboard looks like — it is what the gateway refuses to do.

| Script | The claim |
|---|---|
| `kill-demo.sh` | A live agent is cut off mid-run and restored, without rotating a provider key. |
| `budget-demo.sh` | The budget is part of the authorization decision, so a refused call costs nothing. |
| `scope-demo.sh` | The agent's authority is narrower than the key it never holds. |
| `receipt-demo.sh` | A receipt verifies for someone with no account and no credentials here. |
| `portability-demo.sh` | Two unrelated clients, one identity, one policy, no SDK change. |

## Recording

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
  leave it running: `passcontrol sidecar`. Override the address with `SIDECAR=…`.
- **`budget-demo.sh`** needs an agent whose *remaining* budget is small enough to
  exhaust in a handful of cheap calls, and the cap alone will not get you there:
  `budget_cents` is an integer, so the smallest cap you can set is 1¢ — around
  340 calls of the size this script makes, and it only tries 8. So set the 1¢ cap
  in the dashboard **and** run the agent up near it first, or seed
  `agents.spent_microcents` close to 1000000 (1¢ = 1,000,000 µc) if you have
  database access. The spend the recording opens on was seeded that way; the
  calls, the accounting and the refusal are real. If the budget is never reached
  the script says so and stops rather than looping.
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
- **`portability-demo.sh`** runs the CLI and a raw HTTP client. Set `HERMES=1`
  and substitute your own Hermes task for the second client if you want the
  stronger version, where the second caller is a real agent framework.

## A note on honesty

Each script ends by saying what its demo does *not* prove. `receipt-demo.sh` is
the important one: a receipt attests what the enforcement layer observed and
decided. It is not a claim about whether the model's answer was any good, and it
carries no prompt or completion by design — the evidence should not become
another copy of your sensitive content.
