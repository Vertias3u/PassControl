# Budget ledger: what is proved (version 1, 2026-11-10)

A proof checker (Lean 4) has verified the statements below about a model of the four
ledger scripts in `lib/state/holds.ts`. A test then checks that the real scripts,
on a real Redis, behave as the model says.

## What is proved

Each statement holds after **any** sequence of opens, settles, dispatches, reconcile
raises and record expiries, in any order, starting from an empty ledger.

- **Conservation** (`conservation`). The "reserved" counter always equals the sum of the estimates of the holds that are still open. This holds for tokens and for money.
- **Cap at admission** (`cap_admission`). A hold is created only if spent + reserved, including the new hold, is within each cap that is set, and that cap is not zero.
- **Cap over time** (`cap_bound_tokens`, `cap_bound_cost`, `settle_exact`). Settlement can charge more than the estimate, so spent + reserved can pass the cap. It passes by at most the total of (charged − estimate) over the settlements that charged more, plus what the reconcile raise added. A single settlement changes spent + reserved by exactly (charged − estimate).
- **Idempotence** (`idempotent`, `replay_open_later`, `replay_settle_later`). Repeating any step changes nothing. Opening an existing attempt again, or settling a closed one again, also changes nothing after any other activity, until its record expires.
- **Monotone spend** (`spent_monotone`). "Spent" never goes down, on either counter.
- **No silent release** (`no_silent_release`, `settle_closes`). An open hold stays open with the same estimate until a settle or release of that same attempt. Dispatch, other attempts, the reconcile raise and the passing of time cannot close it.

Every theorem depends only on Lean's three standard axioms (`propext`,
`Classical.choice`, `Quot.sound`). There is no `sorry` and no added axiom.

## Assumptions

- Redis runs each script atomically: one primary, and no script is killed half-way. This is what lets "any sequence" stand for "any concurrent interleaving".
- The agent's four counters and its generation marker are present and are not evicted or rebuilt during the run.
- Amounts stay below 2^53, where Lua's arithmetic is exact.
- The cap-over-time bound assumes every open carries a cap no larger than the stated one. The code takes the cap from each call, so a raised budget raises the bound.

## Not covered

- Period limits (K1), sub-agent ledgers (C(b)) and delegation ledgers.
- First initialisation, the generation and format-tag checks, lost counters ("degraded" settles) and the operator rebuild (`REBASE_LUA`). The rebuild rewrites "spent" on purpose, so monotone spend does not apply to it.
- The reconcile cron, beyond the fact that its raise only moves "spent" up.
- The routes that call these functions, and whether they call them with the right figures.

## Open goals

None.

## Defects found

None: the code broke none of the properties. Two behaviours follow from the design and are worth knowing:

1. **Nothing limits the overshoot.** A completed call is charged what the provider reported, however far above the estimate. The cap therefore bounds admission, not final spend.
2. **Idempotence lasts 900 seconds after a hold closes.** After that the record is gone, and an open with the same attempt id creates a new hold. A settle replayed that late is refused as "no hold", which is safe.

## How the proof is tied to the code

`tests/holds-model.redis.test.ts` holds a TypeScript copy of the model's step
function. It fires 40 seeded random sequences at the real exported functions, in
concurrent bursts with repeated attempt ids. After each burst the real counters,
hold records and replies must match the model for some order of that burst. It
passed on the local Redis on 2026-11-10. It skips when Redis is unreachable, and
fails on CI in that case.

## How to re-check

```
cd proofs/budget && lake build
npx vitest run tests/holds-model.redis.test.ts
```

`lake build` must end with "Build completed successfully" and print eleven
"depends on axioms" lines that name only the three axioms above. Run the second
command from the repository root, with the local Redis (SRH) on `localhost:8079`.
The model's simplifications are listed at the top of `Budget/Model.lean`.
