# Stop checks: what is proved (version 1, 2026-11-10)

The claim: **a call that any stop check refuses never reaches the real provider key
and never goes upstream.**

It is established in two parts. A proof checker (Lean 4) has verified the statements
below about a model of the gateway's decision: `evaluateGate` in `lib/gate.ts` and the
kill-state read in `lib/state/killswitch.ts`.
A test then fires random stop states at the real proxy route and checks that every
call the model refuses resolved no key and sent nothing.

The proof covers the decision for every input. The test covers the route for the
inputs it tries. The difference is listed under "Not covered".

## What is proved

Each statement holds for **every** possible input to the gate.

**1. Allowed only if every step passes.**

- `admits_iff_all_clear`. The gate lets a call through exactly when all six steps clear: kill, suspend, scope, endpoint, policy, budget.
- `clears_is_pass_or_listing`. "Clear" means the step passed. The code has one exception: the scope step is skipped for a model listing, which the endpoint step governs instead.
- `any_fail_refuses`, `any_wait_refuses`. One failing step is enough to refuse. So is one step whose input has not been read yet.
- `admitted_has_every_input`. An admitted call had its kill state read, is not suspended, had its scope and policy supplied, and got a "yes" from the budget reserve.
- `allow_alone_is_not_admission`. A caveat. The gate's verdict reads "allow" whenever nothing has denied *so far*, including when it stopped early on a missing input. Only "allow" together with "complete" is an admission.

**2. Order.**

- `denied_by_is_first_failure`. The step named in `deniedBy` is the first one that fails, in the order kill, suspend, scope, endpoint, policy, budget. Later steps are not consulted.
- `staged_gates_agree`. The route calls the gate several times, each time with more inputs. Two calls that agree on a step and on the steps before it agree on whether that step denies. An early check and a later one can never name different steps.
- `steps_are_the_six_in_order`. Every evaluation records all six steps, once each, in order.

**3. Layered revocation.**

- `platform_kill_denies`, `tenant_kill_denies`, `denylist_denies`. Each of the three kill controls denies on its own, whatever every other input is.
- `kill_step_is_isBlocked`. The gate's kill step and the separate function `isBlocked` are the same test.
- `suspension_denies`. Suspension denies on its own. The step named is kill if a kill control is also armed, and suspend otherwise.
- `every_suspension_source_counts`, `no_suspension_source_is_clear`, `recorded_stop_never_weakens`. The route's "suspended" input is true exactly when one of four things holds: the agent is suspended, its session is stopped, a session stop was just reloaded from the durable record, or the credential itself is suspended. A reloaded stop can add a suspension and can never remove one.
- `admitted_is_not_revoked`, `revocation_gate_refuses_exactly`. An admitted call is neither blocked nor suspended. The route's first check refuses exactly the blocked and the suspended.

**4. Failure posture. The asymmetry is proved as it stands.**

- Default, kill read fails: `kill_read_failure_open`, `kill_read_failure_open_admits`. The read answers "nothing armed", and a call that clears every other step **is admitted**. This is stated as a positive fact, so changing the default to fail-closed breaks a theorem.
- Fail-closed, kill read fails: `kill_read_failure_closed_denies`. Every call is denied at the kill step, for every agent.
- The second way the read can fail (Redis answered, the durable record did not): `record_read_failure_closed_denies`, `record_read_failure_open`, `record_read_failure_keeps_redis_stops`. Closed denies. Open returns what Redis held. Under either posture a stop Redis held still counts.
- `successful_read_ignores_posture`. When nothing failed, the posture changes nothing.
- Policy unreadable: `policy_unreadable_open_admits` (default: the step passes), `policy_unreadable_closed_refuses` (fail-closed: never admitted).

Every theorem depends at most on Lean's three standard axioms (`propext`,
`Classical.choice`, `Quot.sound`). There is no `sorry` and no added axiom.

## Assumptions

- Four checks are answered by code outside the files read: scope matching, the endpoint and pricing rules, policy evaluation, and the budget reserve. The model takes their **answers** as inputs. So the proof says what the gate does with every answer they can give. It does not say those answers are right. (The budget reserve has its own proofs in `proofs/budget`.)
- The kill read is modelled from the point where Redis and the durable record have answered or failed.
- A step keeps its name, its status and its rule. The wording, the HTTP status and the warning marker are dropped, because no decision reads them.

The full list is at the top of `Stops/Model.lean`.

## Not covered

- The service proxy (`app/api/v1/svc/...`), the keyless demo handler, the MCP server and the control plane.
- Rebuilding a lost Redis kill flag from its Postgres record. The proof starts from the record's answer.
- The suspension read itself (`isSuspended` in `lib/state/redis.ts`). On a failed read it returns the same posture as the kill switch. That was seen, not modelled.
- In the route test, these are not exercised: an unreadable policy, the hourly request limit, sub-agent lists, model listings, pricing refusals under a dollar limit, Direct Agent Keys, delegated visas, missions, and the model switch past a pause line. The proof covers the gate's decision for the first five. Nothing here covers the last four.
- Code the route calls in other files was not traced for network calls of its own. The test replaces the global `fetch`, so any such call during a refused request would fail the test.

## Open goals

None.

## Defects found

None: the code broke none of the properties. Four things are worth knowing.

1. **The final gate is acted on only for budget.** The last evaluation before the key (line 2447) re-checks all six steps, but the route reads only `deniedBy === "budget"` from it (line 2473). Kill, suspension, scope, endpoint and policy are refused by the earlier checks (lines 1203, 1380, 1413, 1484). `staged_gates_agree` proves those checks and the final gate cannot disagree, so nothing gets through today. But the final gate is not a backstop. As an experiment, I removed the early kill check: a platform-killed call then resolved the key and went upstream, while the final gate was saying "denied by kill". The same happened with the scope check removed. Refusing whenever the final gate does not admit would close this. I did not change it.
2. **Two checks read "nothing denied" where "admitted" is the stronger test.** The model switch (line 1786) and the fallback check (line 3783) test `!deniedBy`. By `allow_alone_is_not_admission`, that is also true when a step is still waiting for an input. The lines read show kill state, suspension, scope and policy supplied at both places, so it is safe as far as I read. I did not read the code that supplies the hourly counter there.
3. **Failover has two layers.** A fallback is checked against a fresh kill and suspension read (line 3743), then against the full gate on that same fresh state (lines 3767 to 3783). Disabling the first check alone changes nothing. The test fails only when the fresh read is replaced by the old one.
4. **A fixture name.** Kill-state fixtures in 23 test files spell the tenant flag `tenantKill`. The code reads `userKill`. It is harmless today: the value is false in all but two places, and those two set both names. A fixture that armed only `tenantKill` would test nothing.

## Every place the route reads a key or calls out

Found by searching the route file for `getCachedKey(`, `get_provider_key`,
`get_provider_key_for_credential` and `fetch(`.

| Line | What it does | What must allow first |
|---|---|---|
| 2981 | `getCachedKey`: reads the key from the encrypted cache | The budget reserve via the final gate (2447, 2473), inside an attempt. An attempt starts only after the checks below. |
| 3004 | `get_provider_key_for_credential`: decrypts from Vault, bound credential | Same as 2981. Runs only when the cache had no key. |
| 3009 | `get_provider_key`: decrypts from Vault | Same as 2981. Runs only when the cache had no key. |
| 3357 | `fetch(targetUrl)`: sends the call to the provider | Same as 2981, then the dispatch permission (3350). |
| 390, 402, 795, 2835 | Comments that mention `get_provider_key` | Not calls. |

There is one of each in the file. First attempts and fallbacks both pass through
these four lines. What must allow before an attempt starts:

| Attempt | Checks, in order |
|---|---|
| The call as the agent sent it | kill and suspension (1194, 1203), scope (1379, 1380), endpoint (1413), policy (1484) |
| The owner's cheaper model past a pause line | all of the above for the original model, then the gate again for the cheaper one (1779, 1786) |
| A fallback after the first provider failed | a fresh kill and suspension read (3728, 3743), then the gate for the fallback's provider and model on that fresh state (3767, 3783) |

## How the proof is tied to the code

`tests/stop-checks-route.test.ts` holds a TypeScript copy of the model, function
for function. It runs the real route handler on the mock harness of
`tests/proxy-sdk-shape.test.ts`:

- **400 seeded random stop states**: platform kill, tenant kill, denylist, agent suspension, session stop (read from Redis or reloaded from the record), an out-of-scope model, a path that is not allowlisted, a policy deny rule, an exhausted budget, and the kill read throwing under five spellings of `KILL_SWITCH_FAIL_CLOSED`. Several can be armed at once. For the throwing read the real `readKillState` runs against a Redis client that throws.
- For every call the model refuses: zero cache reads, zero Vault calls, zero `fetch` calls, and no budget reserve unless budget was the step that refused.
- For every call the model admits: one of each, in the order credential, kill and suspension reads, reserve, cache, Vault, upstream.
- **15 single stops**, each armed alone with everything else clear.
- **150 seeded failovers**: the first provider fails, and the second kill and suspension read finds a random stop state. If the model refuses, there is exactly one key resolution and one send. If it admits, there are two, and the second goes to the fallback provider.

It passed on 2026-11-10. To check that the test can fail, I broke the route four
ways, one at a time, and restored it after each:

| Change to the route | Result |
|---|---|
| Key read and Vault call placed above the final gate | Failed. A budget-refused call showed one cache read and one Vault call. |
| Early kill and suspension check removed | Failed. A platform-killed call went upstream. |
| Scope check removed | Failed. An out-of-scope call went upstream. |
| Failover's fresh read replaced by the first read | Failed. A call stopped between attempts reached a second key. |

## How to re-check

```
cd proofs/stops && lake build
npx vitest run tests/stop-checks-route.test.ts
```

`lake build` must end with "Build completed successfully" and print one line per theorem that
reads "depends on axioms" or "does not depend on any axioms", naming only the
three axioms above. Run the second command from the repository root. It needs no
Redis and no database.
