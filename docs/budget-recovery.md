# Budget recovery

What to do when the gateway refuses a call because it does not know what an
agent has spent, and how to decide an attempt whose ending never arrived.

Everything here is manual on purpose. The two situations below are the two
places where the honest answer is "this system cannot know", and every automatic
answer to them either invents capacity or destroys it.

---

## The one rule

**Nothing in the gateway ever lowers a spend counter except the rebuild in this
document, and the rebuild is audited.**

Reservations, settlements, and the nightly reconcile can all raise `spent:`.
None of them can lower it. That asymmetry is the whole defence: a lost
settlement costs an operator nothing but a slightly conservative budget, while a
wrongly lowered counter hands out capacity for money that was really spent — to
an agent, automatically, at machine speed.

So a lowering is a decision a person makes, with the evidence in front of them,
and it leaves a row in `admin_audit`.

---

## Situation 1 — `503 blocked_budget_state`

### What the agent sees

```json
{ "error": "blocked_budget_state" }
```

with HTTP **503** and an `x-passcontrol-receipt-id` header. The call is recorded
with status `blocked_budget_state`, which the dashboard shows as **NO
RECKONING**.

### What it means

It does **not** mean the agent is out of budget. A cap denial is `402
blocked_budget`, and the two must never be read as the same thing.

`blocked_budget_state` means the gateway's spend counters for this agent are
missing or belong to a generation the database does not recognise — a Redis
flush, an eviction, a restore from a different instance. The gateway knows this
agent has spent *something*, because `agents.budget_state_established_at` is
set, but it can no longer say how much.

It refuses rather than guessing, and this is deliberate. The predecessor of this
check re-seeded the counters from a best-effort mirror column that is dropped
silently on failure, so a flush handed the agent's entire spending history back
as fresh capacity. Refusing is loud, recoverable, and costs nothing but a pause.

### What to do

Review the retained evidence, then run a rebuild (below). It recomputes spend from
logs and adjustments and points both stores at a new generation. Resume only after
checking the response and unresolved holds; missing logs cannot be reconstructed.

If the agent is **not** budgeted, it cannot hit this at all; the check only runs
for agents with a token or cost cap.

### One extra case, only around the upgrade

An agent that was already spending before the accounting state existed has no
generation of its own: migration 0057 marks it by setting
`budget_state_established_at` while leaving `budget_epoch` NULL. On its first
call after the upgrade, the gateway **adopts** whatever counters Redis is
holding and mints the missing generation — nothing to do, nothing to notice.

If those counters are gone by then, that agent answers `blocked_budget_state`
like any other, and the remedy is the same rebuild. What is worth knowing is
why the answer is a refusal rather than a fresh start: the markers alone cannot
distinguish "budget granted, never spent" from "spending since long before this
column existed", and treating the second as the first refunds the entire cap.
0057 is what tells them apart, using the spend the database has recorded.

One consequence to expect, and it is the reason a rebuild here deserves a look
at the figures first: a rebuild sums the agent's whole history in `agent_logs`,
which for an agent that ran unbudgeted for a long time before being given a cap
includes spend from before that cap existed.

---

## Situation 2 — an open hold

### What it is

Every attempt takes a **hold** before it dispatches: an estimate of what the
call might cost, reserved against the cap so concurrent requests cannot
collectively overspend it. An ending attempts to settle that hold. Complete usage settles observed figures;
uncertain usage keeps at least the estimate or higher observed usage. A settlement
failure can leave the hold open. Neither a broken stream nor a thrown error establishes
a real final price.

An **open hold** is an attempt where no ending ever ran. A worker was killed
between dispatch and settlement. A response body was never consumed. The process
went away.

Its capacity stays consumed. Indefinitely. **Holds do not expire, and that is
the point** — expiry-as-release was the original defect: it released money that
had genuinely been spent, on a timer, for exactly the failures where spending is
most likely.

### How to see them

```
GET /api/control/v1/agents/{agent_id}/holds
```

Read scope. Returns each open attempt with when it started, how old it is, and
the estimate it is holding in both dimensions:

```json
{
  "data": {
    "agent_id": "…",
    "holds": [
      {
        "attempt_id": "…",
        "created_at": "2026-09-05T11:02:14.000Z",
        "age_ms": 5400000,
        "estimate_tokens": 4000,
        "estimate_microcents": 1200,
        "provider": "anthropic",
        "model": "claude-opus-5",
        "may_have_dispatched": true
      }
    ]
  }
}
```

A recent hold may be in flight. An old hold warrants investigation; age alone
does not establish whether a request is still running or was billed.

`provider` and `model` come back `null` on holds opened before this surface
existed. Everything else is always present.

**`may_have_dispatched` decides which decisions are open to you**, so read it
before anything else on the line:

- **`true`** — the attempt claimed its one-use permission to reach the provider,
  and the request may have gone out and been billed. `not_spent` will be
  **refused** for this hold. Your options are `spent` with an amount, or leaving
  it open until you have the evidence to name one.
- **`false`** — the attempt never got as far as sending. It provably did not
  reach a provider, and it is the one case where `not_spent` is honest.

The gateway knows this because it claims that permission in the instant before
it forwards, which is also what stops the same attempt being sent twice. It is
not a guess from the hold's age, and age is not a substitute for it: a hold can
be hours old and never have left.

The nightly reconcile reports a count of these and **never acts on them**. A
cron that tidied up open holds would be the expiry bug with a scheduler
attached.

### Deciding one

The question is only ever: **did the provider bill for this attempt?**

The gateway cannot answer it. The connection died on the far side; whether the
request completed upstream is a fact that lives with the provider.

**Expect there to be no receipt.** This surprises people, so it is worth being
explicit: the receipt and the `agent_logs` row are both written by the
settlement path, and an open hold is by definition an attempt where that path
never ran. The attempt id appears nowhere else in the product. So for the usual
case there is no call to look up, and its absence is not a second problem to
investigate — it is the same one.

(A hold can also stay open when the settlement itself failed to reach Redis
while the row was written. In that case a receipt does exist, and it is worth a
look. It is the rarer shape.)

Evidence, in the order it is actually available:

1. **The hold record itself** — what the list above returns. `provider`,
   `model` and `created_at` are what identify the call; the estimates are what
   it is holding.
2. **The provider's own dashboard or usage export.** The authority on what was
   actually charged, and in practice the only one. Match on the provider, the
   model, and the minute in `created_at`; a request that reached the provider
   appears there within its usage-reporting delay.
3. **A receipt, if one exists.** Search the agent's calls around `created_at`
   for the same model. Usually there is nothing, for the reason above.

If none of it settles the question, **charge it**. Over-charging an agent costs
its owner a little headroom until the next budget period. Under-charging spends
real money and calls it free.

### Recording the decision

```
POST /api/control/v1/agents/{agent_id}/holds/{attempt_id}/resolve
```

Write scope. Body:

```json
{ "outcome": "spent", "tokens": 3820, "microcents": 940 }
```

or

```json
{ "outcome": "not_spent" }
```

`spent` charges the figures you supply and releases the estimate. It must name
at least one of `tokens` and `microcents` — a spend body that names neither is
rejected rather than treated as zero, because the shortest possible way to say
"this was spent" should not be the way to charge nothing.

`not_spent` releases the whole hold and charges nothing — use it only when you
can show the request never reached a provider. **The gateway will refuse it
outright for any hold whose `may_have_dispatched` is `true`**, and that refusal
is not advisory: the release does not happen. This is deliberate. An attempt
that claimed its dispatch permission may be inside a provider call at this
moment, and handing its capacity back would free money that is in the process of
being spent.

**`{"outcome": "spent", "tokens": 0, "microcents": 0}` is not the same
statement as `not_spent`.** It says the call reached the provider and cost
nothing, which is a real outcome for some endpoints. `not_spent` says it never
left. Both release the same estimate; they differ in what the record then
claims happened.

The response includes:

- `applied` — `false` means the hold had already reached a terminal state. The
  numbers beside it are the **first** resolution's, not this call's. This is not
  an error; it is a retried or duplicated resolve doing nothing, which is what
  you want. Inspect the other response flags too: state-lost retries may write or correct the adjustment ledger.
- `refused_dispatched` — `true` means the hold is **still open** and refused
  this particular outcome, because the attempt may really have reached the
  provider. It is the other reason `applied` can be `false`, and it means the
  opposite thing: a replay is a hold somebody already finished, this is a hold
  nobody has finished and that you have just been told you cannot write off.
  Come back with an amount, or with the evidence. Do not read `applied: false`
  alone as "handled".
- `state_lost` — `true` means the hold **did** close and the amounts beside it
  are what the attempt cost, but this agent's counters were gone, so nothing
  was added to them. It is not about this attempt at all — it is the agent-wide
  loss of Situation 1 showing up while you were resolving a hold. The attempt
  needs nothing more from you; the agent needs a rebuild, and until it gets one
  every call it makes returns `503 blocked_budget_state`. Check `ledger_recorded`: only a successful write to `agent_spend_adjustments`
  makes the figure available to the rebuild.
**For a state-lost hold with an adjustment row, a repeat can correct that ledger row.**
An ordinary successful settlement is not rewritten by repeating resolve. Until a rebuild runs, that row is the only record of what the
attempt cost, so a typo would otherwise be permanent — and the amounts this
endpoint accepts go up to 100M tokens and 100 USD, which is plenty of room to
mistype one by a factor of ten and be believed. A repeat writes the new figures
over the old, and answers with `ledger_corrected: true` and the
`recorded_tokens` / `recorded_microcents` it stored. Read those, **not**
`applied_tokens`: that one is the hold's and keeps the first resolution's
figures forever, so on a correction it still shows the number you came to
replace. Both versions are in `admin_audit`.

- `ledger_recorded` — only meaningful beside `state_lost: true`, and the one
  answer here that needs you to come back. `false` means that write did **not**
  land, so the rebuild you are about to run will come back short by exactly
  `applied_tokens` / `applied_microcents`. **Repeat the resolve before
  rebuilding** — repeating it retries the write, and a replayed resolve of a
  state-lost hold reports `state_lost` again rather than "already handled",
  which exists so that this retry works.
- `unknown_attempt` — no hold record at all, not even a spent one. Either the
  attempt id never existed, or it was resolved more than 15 minutes ago and its
  tombstone has expired. Nothing moved.

Every call writes a `budget.hold_resolve` row to `admin_audit`, including the
ones that applied nothing — a second operator reaching for the same hold is
itself worth recording.

---

## The rebuild

```
POST /api/control/v1/agents/{agent_id}/budget/rebuild
```

Write scope, no body. It:

1. Recomputes total spend for the agent via `rebuild_agent_spend`, and **sets**
   the reconcile checkpoint to that total rather than advancing it. Two inputs:
   `agent_logs`, and the operator decisions in `agent_spend_adjustments`. **What
   the gateway observed always wins**: your figure applies only to an attempt
   the log has no countable row for at all. That is what it is for — an attempt
   the gateway never managed to record. So resolving a hold whose call was
   already logged never charges it twice, and a mistyped figure can never
   override a real measurement, including a real measurement of zero: a
   discovery call that genuinely cost nothing stays free.
2. Writes a new `budget_epoch` to Postgres, then rebases the Redis counters onto
   it: `spent:` is set from the rebuild, and `reserved:` is **seeded only if it
   is missing**.
3. Purges the agent's cached policy, so the next call reads the new generation
   immediately instead of at the end of a cache window.

**A log row that arrives after the rebuild is handled.** The gateway writes its
audit row in the background, so a row for an attempt you had already resolved by
hand can land minutes later — dated after the watermark the rebuild set. The
nightly fold charges only the amount by which that row exceeds the figure you
supplied, so the same call is never counted twice, and a call that turned out to
cost more than you recorded is topped up without another rebuild.

Step 2 preserves a live reservation counter across concurrent hold transitions. `reserved:` moves exclusively through
atomic transitions, so a live counter is correct by construction and the rebuild
leaves it alone; overwriting it with a summed read would let a hold that opened
mid-rebuild lose its reservation and, on settling, drive the counter negative —
which would widen capacity, on the one route whose whole justification is being
the only place capacity is ever handed back deliberately.

The response reports both the live counter and what the open holds add up to, so
a disagreement is visible rather than quietly written away. They should be
equal. If they are not, that is a finding, not something to re-run until it
goes away.

**A rebuild is not routine retry advice.** It recomputes from retained history rather
than applying a delta, but concurrent or late writes can change that history. Review
partial failures and the returned counters before repeating; each rebuild creates a
new generation. A generation mismatch refuses admission.

**Open holds survive a rebuild**, deliberately. A rebuild is not a decision
about them; their estimates simply become the new `reserved:`. Resolve them
individually.

The response tells you what it landed on:

```json
{
  "data": {
    "agent_id": "…",
    "budget_epoch": "…",
    "spent_tokens": 41200,
    "spent_microcents": 8830,
    "reserved_tokens": 4000,
    "reserved_microcents": 1200,
    "computed_reserved_tokens": 4000,
    "computed_reserved_microcents": 1200,
    "seeded_reserved": false,
    "holds_truncated": false,
    "open_holds": 1
  }
}
```

`seeded_reserved: false` is the ordinary answer — the counter was already there
and already right. `true` means it was missing and this rebuild established it,
which is the state-loss case.

`holds_truncated: true` means the agent has more open holds than one read
returns, so `computed_reserved_*` is partial. An agent in that state has a
problem a rebuild is not the answer to; resolve the backlog first.

### When to run one

- After a `blocked_budget_state` refusal. This is what clears it.
- After restoring Redis from a backup, or moving to a different Redis instance.
- When the counters and `agent_logs` have visibly parted company and you want
  the record to win.

### When *not* to

Not as routine maintenance, and not to give an agent more room — that is a
budget change, made on the agent. A rebuild sets spend to what the record says;
if the record says the agent spent its cap, the rebuild will say so too.

### After a rebuild that followed a `state_lost`

Check the open holds once more. A hold that closed while the counters were
missing never released its reservation, and the rebuild seeds `reserved` only
if it is **absent** — so if the reservation counter is the one that survived the
loss, that estimate stays on the books as load against a request that finished.
It is visible as `reserved_tokens` exceeding the sum of the open holds' own
estimates, which the rebuild response prints side by side for this reason.
Do not assume a second rebuild repairs this: existing reservation counters are
preserved even when no open holds remain. The recovery API does not provide
a documented automatic repair for that disagreement. Preserve evidence and investigate
the state with the maintainer before changing counters manually.

Do not try to net it out during settlement instead. Partially repairing damaged
counters — moving one because it exists, skipping another because it does not —
is the shape of the original defect, not the fix for it.

### What it cannot recover

Spend that never reached `agent_logs` at all. The rebuild reads the record; it
cannot reconstruct calls the record does not contain. Missing evidence can under-count. Conversely, retained conservative charges or
incorrect operator adjustments can exceed actual billing; a rebuild is not an invoice audit.

Two things are missing, and the second one is bigger than it looks:

- **The reconcile lag** — a row committing at the moment of the read. A sliver.
- **An attempt whose own logging machinery threw.** When the code that writes
  the audit row is the code that failed, the proxy closes the hold directly
  rather than through the path that also writes the row (`runAttempt`'s catch),
  because settling through the machinery that just threw would leak the
  reservation. That charge is therefore enforced in Redis and absent from
  `agent_logs` — so a rebuild, which recomputes from the record, drops it. The
  error is captured; the charge is not recorded. This predates the state-loss
  work and is not changed by it, but it is the one case where a rebuild can
  lower an agent's recorded spend below what it really spent, and it is why a
  rebuild is a deliberate operator action rather than something automatic.

  An attempt you resolved by hand is **not** in this category: your figure goes
  to `agent_spend_adjustments` and the rebuild reads it. That is the difference
  between a charge nobody recorded and a charge nobody observed.

---

## Related

- `db/migrations/0055_budget_attempt_accounting.sql` — the view both the
  incremental fold and the rebuild read, so the two can never disagree about
  which rows count.
- `SECURITY.md` — the trust boundaries these routes sit on.
