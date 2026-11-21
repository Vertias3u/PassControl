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

## Service proxy

The service proxy (`app/api/v1/svc/[service]/[...path]/route.ts`) is the second
place a real credential is injected: the tenant's GitHub token, decrypted by
`get_provider_key`. It has no final gate. Every check is an early `return`, so
"a stopped call never reaches the key" rests on the order of those returns. The
model is `Stops/Service.lean`: the checks as one ordered list, then the key read
(step 7), then the send (step 8). Step 2 reuses the kill read, the suspension
fold and the gate from the sections above, with the per-service flag added.

### What is proved

- **The key is read only if every earlier check passed** (`key_read_iff`, `refusal_before_key`). If any of the 19 checks before step 7 refuses, `get_provider_key` is not called and nothing is sent, whatever every other input is.
- **A call is sent only if every check passed** (`sent_iff`, `sent_needs_key`), before and after the key read.
- **Step 2 refuses exactly three things** (`revocation_refuses_iff`): a kill control (platform, tenant, denylist), a suspension from any source, or this service's kill.
- **The per-service kill denies on its own** (`service_kill_denies`), whatever else holds. It is seen whenever Redis answers, and when a stop that is only in the record is reloaded (`service_flag_in_redis_is_seen`, `service_stop_in_record_is_seen`).
- **It denies only the service it names** (`service_kill_names_its_service`, `other_service_kill_is_not_this_one`).
- **Its failure posture, exactly.** The flag itself never reads the environment (`service_flag_ignores_posture`).

  | What failed | `KILL_SWITCH_FAIL_CLOSED` not `"true"` | `KILL_SWITCH_FAIL_CLOSED="true"` |
  |---|---|---|
  | Redis read | The service kill is **not enforced**. Only suspension can refuse at step 2 (`service_kill_redis_failed_open`). | Every service call is refused before the key (`service_kill_redis_failed_closed`). |
  | Record read (Redis answered but had lost the tenant's stops) | What Redis holds still counts. A service stop that survives only in the record is **not enforced** (`service_kill_record_failed_open`). | Refused before the key (`service_kill_record_failed_closed`). |

- **The fail-closed checks stay closed** (`unreadable_rules_never_reach_key`, `unreadable_cap_never_reaches_key`). An unreadable rules row or hourly counter never reaches the key, under any environment. No check other than step 2 reads the posture at all (`only_step_two_reads_posture`).
- **Rules, cap and never list** (`unadmitted_rules_never_reach_key`, `exhausted_cap_never_reaches_key`, `never_list_never_reaches_key`): each refuses before the key.
- **Ask me first** (`asked_call_needs_approval`): a call that asks reaches the key only when the owner's answer is "approved".
- **Both doors** (`door_does_not_change_checks`, `direct_key_revocation_is_no_weaker`, `doors_agree_at_revocation`, `suspended_direct_key_never_reaches_key`). Apart from the sender proof, which only a passport has, every check answers the same on both doors. At step 2 the Direct Agent Key door adds one stop, the key's own suspended agent, and removes none.
- **After the key read** (`refusal_after_key`, `no_token_is_not_sent`): a failed or empty key read sends nothing.

All of these depend only on `propext` and `Quot.sound`, or on no axiom.

### Assumptions

- The route's checks run in the order of the file, one after another, as read on 2026-11-10 (lines 111 to 770).
- Each helper's answer is an input: the rules parser and matcher, the catalog's never list, the two rate limiters, the approval queue, the mission check and authentication. The proofs say what the route does with each answer, not that the helpers are right.
- The route's `asks` flag (rule asks, injection hold, outside a mission) is an input.

### Not covered

- Step 9: the answer, redaction, the audit row and the receipt.
- Whether a refusal writes the right audit row or status.
- Missions, the injection guard's hold and the sender proof, beyond "a refusal there is before the key".
- The kill-record reload and `isSuspended` themselves, as in the sections above.

### Every refusal in the route

Lines are the `return`. "Row" is whether the refusal writes an audit row and receipt.

| Line | Step | Refuses when | Row |
|---|---|---|---|
| 116 | before 1 | the service is not in the catalog | no |
| 127 | before 1 | the path does not parse | no |
| 134 | 1 | authentication fails, on either door | by the door |
| 152 | 1 | the passport's sender proof fails | by the helper |
| 309 | 2 | kill control, suspension, or this service's kill | yes |
| 337 | 2b | the mission check refuses | yes |
| 344 | 3 | the agent's gateway-wide rate limit is spent | no, on purpose (as on the LLM route) |
| 355 | 4 | the catalog's never list | yes |
| 383 | 5 | the rules row is unreadable (fails closed) | yes |
| 390 | 5 | the rules are malformed | yes |
| 404 | 5 | no rules, or none admits the call | yes |
| 457 | 6 | the hourly counter is unreadable (fails closed) | yes |
| 467 | 6 | the hourly cap is spent | yes |
| 481 | 6b | a write's media type is not accepted | yes |
| 486 | 6b | a write's body is over the bound | yes |
| 503 | 6b | the query string cannot be forwarded | yes |
| 551 | 6c | approval needed, path too long to show | yes |
| 562 | 6c | approval needed, request too large to show | yes |
| 619, 631, 635, 646 | 6c | approval unavailable, queue full, denied, pending | yes |
| 653 | 7 | **`get_provider_key` is called here** | |
| 664 | 7 | the key read failed | yes |
| 668 | 7 | no token is stored | yes |
| 692 | 7 | the stored token is not in the service's shape (before the Cloud allowance) | yes |
| 753 | 8 | **`fetch` is called here** | |
| 767 | 8 | the send threw (may have reached the service) | yes |


### Anything that looks wrong

No property is broken. Five things are worth knowing.

1. **A per-service kill is not enforced while Redis is unreadable, unless `KILL_SWITCH_FAIL_CLOSED="true"`.** This is the kill switch's documented posture, and the route says it shares it. In a full Redis outage the hourly cap (step 6) fails closed, so the call is probably refused there instead. I did not read the limiter to confirm it uses the same Redis.
2. **The same posture has a quieter case.** If Redis answers but has lost the tenant's stops, and the record cannot be read, a service stop that lives only in the record is not enforced. Redis is working, so step 6 passes and the call goes through. Fail-closed refuses it.
3. **The gateway-wide rate limit (line 344) writes no audit row.** Every other refusal after authentication does. Kept on purpose (2026-11-10): a row and a signed receipt per refused call would let a flood buy one database write each; the LLM route does the same.
4. **The hourly cap is counted before the body and approval checks.** A call refused at 6b or 6c has already used one of the hour's calls. The code comments say this is intended for approval retries.
5. **The route's header says "the same order as the LLM route".** It is the same order of steps, but not the same shape: there is no final gate here. Any new check must be placed above line 653 by hand, and the test below is what would catch a mistake.

### How the proof is tied to the code

`tests/stop-checks-service.test.ts` holds a TypeScript copy of the model and runs
the real route handler on the mock harness of `tests/proxy-service.test.ts`.

- **600 seeded random states**, several stops armed at once: platform, tenant and per-service kill (this service and another), the denylist, agent suspension, a session stop (read or reloaded), the kill read throwing under five spellings of the variable, rules that deny, are missing, are malformed or cannot be read, a never-listed path, the hourly cap spent or unreadable, an approval pending, denied, full or unavailable, a failed or empty key read, and each door. For the throwing read the real `readKillState` runs against a Redis client that throws.
- For every call the model refuses before step 7: zero `get_provider_key` calls and zero upstream fetches. The error code must be the one the model's check gives.
- For every call that reaches the key: one key read, after the kill and suspension reads, and the send after the key read.
- **Each stop armed alone**, on each door.
- Every armed check must refuse at least once on each door, so the test cannot pass by never arming something.

It passed on 2026-11-10. To check that it can fail, I moved the decrypt above
step 5 once: the test failed ("refused by rulesUnreadable, yet the key was
read", and the same for the cap and the other rules cases). I restored the
route. The test also passes with the private blocks removed from it and from the
route.

Not exercised by the test, only proved in the model: an unknown service, a bad
path, failed authentication, a failed sender proof, a mission refusal, the body
and query checks, an approval too large to show, and a token in the wrong shape.
The record-read failure is armed from the model's answer, not by running the
real reload.

### How to re-check

```
cd proofs/stops && lake build
npx vitest run tests/stop-checks-service.test.ts
```

## Fresh stop before every send

Added 2026-11-13, against commit `27e2273`. Model: `Stops/Dispatch.lean`. Route
test: `tests/stop-checks-dispatch.test.ts`.

### Why this section exists

Everything above treats a request as one moment: all the stops are read, the
checks run in order, the key is used. A real request has a length. It uploads a
body, may wait for an approval, opens a hold, fetches the key, and may try a
second provider when the first one fails. A stop can arrive in the middle.

Think of a courier who checks the "do not deliver" list when a parcel is handed
in. If the list changes while the parcel waits in the depot, that check is
worthless. The list has to be read again at the van door. Audit B2 found four
places where it was not (a slow upload, an approval wait, and three kinds of
failover). Commit `726a365` added the second look. This section proves the rule
that fix is meant to enforce, for every path, including paths added later.

The model is a request as a list of steps: the admission reads, the body, the
approval wait, the hold, each read of a re-check, the key, the dispatch
permission, the send, and the refusal. Between any two steps the world may
change in any way: a stop is armed or lifted, time passes, a store stops
answering. The ten stops are: platform, tenant, denylist, per-service, session,
suspend (these six live in Redis and are read together), delegation revoked,
mission ended, Direct Agent Key revoked (three "authority" reads, each its own
lookup), and expiry of the visa or delegation link.

### What is proved

The proofs hold for every request shape, every starting state and every
sequence of events, at every point of the run.

**1. Fresh read before every send** (`fresh_read_before_every_send`).
The step immediately before every upstream send is a read of the Redis stops,
made by that attempt's own check. It covers every Redis stop that applies (the
per-service stop exists on the service route only), on the first attempt and on
every failover, on the LLM route and the service route. Nothing sits between
that read and the send.

For the three authority stops the statement the brief asked for ("read
immediately before every send") is **not true of the code**, so it is not what
is proved. What is true and proved: each was read, and its latest read belongs to
a check that began at most 2 seconds before the last check began. On a failover,
that read was made inside the failover attempt itself.

**2. No send after a stop** (`no_send_after_a_stop`).
If a send happened, every read it rests on came back clear. Put the other way:
a stop that was in force when its governing read ran means that send is not in
the trace. The governing read is the last step before the send for a Redis stop,
and the stop's latest read for an authority stop. Each stop's behaviour when its
store cannot be read is stated exactly:

| Stop | Store unreadable, default | Store unreadable, `KILL_SWITCH_FAIL_CLOSED=true` | Theorem |
| --- | --- | --- | --- |
| platform, tenant, denylist, per-service | sent (fail open) | refused | `posture_kill_switch` |
| session, suspend | sent (fail open) | refused | `posture_suspend` |
| delegation, mission, Direct Agent Key | refused | refused | `posture_authority` |
| expiry | cannot be unreadable | same | `posture_expiry` |

`fail_closed_send_means_clear_redis_read`: with the variable set, a send means
the Redis read succeeded and found nothing armed.
`fail_open_send_despite_stop_means_unreadable`: by default, a send can follow an
armed Redis stop in exactly one case, an unreadable store.
`authority_stop_blocks_send_under_both_postures`: an unreadable Direct Agent Key,
mission or delegation is never sent on, under either setting.
`kill_posture_is_the_proved_one` ties the kill-switch row to the kill read
already proved in the first section.

**3. The 2-second rule** (`the_only_windows`). See the next heading.

**4. A refusal after the hold releases it** (`refusal_after_hold_closes_it`).
A refusal is the last step of its trace. Nothing follows it, so no key is
resolved and nothing is sent afterwards. When the refusal comes from a re-check
on the LLM route, the step right before it closes that attempt's hold: released
as "not dispatched", or settled at zero when the dispatch permission had already
been taken. And that hold was opened earlier in the same trace.
`refused_read_goes_to_refusal` and `recheck_refusal_finishes` add that a read
which sees a stop always ends in that refusal, two steps later.

Also proved: `the_trace_is_a_timeline` (each step sees exactly the world left by
the events before it) and `clock_never_runs_back`.

`lake build` prints one line for each theorem of this section (they are listed
in `Stops/Axioms.lean`). None depends on anything beyond `propext`, `Quot.sound`
and `Classical.choice`. There is no `sorry`.

### The 2-second window, in plain words

Reading the three authority stops costs a database or Redis round trip each. To
keep an ordinary fast call from paying that twice, the fix reuses an authority
read while it is less than 2 seconds old (`DISPATCH_AUTHORITY_MAX_AGE_MS`). The
six Redis stops are never reused. They are read fresh before every send.

So a window exists for exactly three stops: **delegation revoked, mission ended,
Direct Agent Key revoked**. If one of them lands after its latest read, and the
last check starts within 2 seconds of that read, the call still goes out.

`the_only_windows` proves there is nothing else. A call can go out while a stop
the code re-reads is in force in only two ways:

- a Redis stop whose store could not be read, on the default fail-open setting
  (the row in the table above); or
- one of the three authority stops, landing after its own latest read, where
  that read is at most 2 seconds older than the start of the last check.

Three things about that window are worth knowing. The second is a finding.

1. **First attempt, as intended.** A delegation revoked 100 ms after admission,
   on a fast call, is not seen: the call is sent
   (`window_fast_first_attempt_is_open`). The same revoke after a 2001 ms upload
   is seen and refused before the key (`slow_first_attempt_is_reread`).

2. **Failover: the window is not closed. The brief said it was.** Before a
   failover's key, the three authority reads are forced. But the check at the
   send is the ordinary one, which reuses a read under 2 seconds old
   (`route.ts:3451` calls `checkDispatchStops()` with no argument, on every
   attempt). So a delegation revoked while the failover's key is being resolved
   is not seen, and the failover is sent
   (`failover_window_is_open_between_its_read_and_its_send`; the same for a
   mission and a Direct Agent Key in
   `failover_window_is_open_for_mission_and_direct_key`). The real route does
   the same: three tests named "OPEN WINDOW, failover" pin it.
   What does hold for a failover: its authority reads are never older than the
   attempt itself, so a stop that landed any time before the failover began is
   always caught (`B2_03_...`, `B2_04_...`, `B2_05_...`). The remaining window
   is the stretch between the failover's forced read and its send: one key
   lookup and one dispatch-permission call, normally short. A Redis stop has no such window (`redis_stop_has_no_failover_window`).
   Closing it would mean forcing the three reads at the send on a failover: up
   to three more lookups per failover attempt. That is the owner's call. If it
   is made, the two `failover_window_is_open...` theorems and the three "OPEN
   WINDOW" tests stop passing, which is how the change will show.

3. **The 2 seconds are measured to the start of the last check, not to the
   send.** The last check can itself be slow. Example
   (`the_window_is_measured_to_the_start_of_the_last_check`): the key is re-read
   at 2.1 s; the last check starts 1.95 s later, so the key is not read again,
   but the mission is, and that lookup takes 10 s; the key is revoked meanwhile;
   the call goes out on a key read that is 11.95 s old. It needs a database that
   is ten seconds slow, so it is rare. It is also exactly what the code does.

### Expiry is re-read (gap B5-05, closed by commit `944adc4`)

Updated 2026-11-13. The code now compares the visa's and the delegation link's
expiry on every re-check, and once more before a delegated visa's hold, so the
model treats expiry as a re-read stop and the old counterexample is gone.
`expiry_has_no_window` proves that before every send, expiry was compared by
that attempt's own last check and had not passed: unlike the three authority
stops it has no 2-second window, on a first attempt or a failover
(`expiry_shortly_after_admission_is_refused`, `expiry_has_no_failover_window`).
`B5_05_expiry_during_upload_opens_no_hold` is the old escaping trace, now
refused with no hold, and `B5_05_was_open_before_the_fix` keeps the gap on
record as a statement about the code before the commit.

### What the model leaves out

The full list (D1 to D16) is at the top of `Stops/Dispatch.lean`. In short:

- **Other refusals.** Rate limit, scope, policy, budget cap, pricing, the
  injection guard, a denied approval, a missing key, a refused dispatch
  permission. Each ends the attempt without a send, so leaving them out removes
  only traces with fewer sends. Their order is the subject of the sections above.
- **A step is instant.** An event lands before a step or after it, never during.
  A read "sees" the world at the instant the store answered.
- **A mission is one bit** ("the mission gate would now refuse"), and so is a
  Direct Agent Key ("no longer authenticates as the same active agent"). The
  mission gate's own logic is not modelled here.
- **Expiry is an event**, not computed from the clock. A mission running out of
  its time window counts as "mission ended", because the mission re-read does
  compare the clock.
- **The order inside admission** is fixed in the model and differs slightly
  between the two routes. Nothing here depends on it.
- **When an authority read refuses**, the code still makes its Redis read and
  reports the Redis stop if both refuse. The model stops at the first refusal.
- **A session stop** is seen through the suspend read only. The second way the
  code can see it (reloaded from the record) is left out.
- **A second kind of kill-read failure** (Redis answers, the record does not) is
  in the first section, not here.
- **Money.** The hold of a sent attempt is settled in the next step. Whether the
  amount is right belongs to `proofs/budget`.
- **After the send.** A stop that lands once the request has gone out does not
  un-send it, and a response already streaming is not modelled.
- **Finishing.** The model does not prove a request ends. It proves what is true
  at every point, and that a refused re-check ends two steps later.
- The demo route (no upstream call), the control plane, and the Claude/Codex
  subscription hooks (which cache "open" for 5 to 15 seconds by design and do
  not pass through the gateway).

### Mutation results

To show the theorems are not empty, I changed the model on a scratch copy and
rebuilt. `step_inv` is the one-step lemma that theorems 1 to 4 all rest on.

| Change to the model | What stops compiling |
| --- | --- |
| Delete both re-checks on a failover attempt | `step_inv`, `B2_03_...`, `B2_04_...`, `B2_05_...`, `slow_failover_is_reread`, `redis_stop_has_no_failover_window` |
| Keep them but do not force the authority reads on a failover (the bug before the fix) | `forced_is_due` (a lemma `step_inv` rests on), `B2_03_...`, `B2_04_...`, `B2_05_...` |
| Delete both re-checks on the first attempt | `step_inv`, `B2_01_...`, `B2_02_...`, `slow_first_attempt_is_reread`, `stop_during_permission_is_caught_at_the_send`, `unreadable_kill_switch_fail_closed_refuses`, `unreadable_direct_key_refuses_under_both`, the expiry examples |
| Delete only the check at the send | `step_inv`, `stop_during_permission_is_caught_at_the_send`, `slow_failover_is_reread`, `redis_stop_has_no_failover_window`, `unreadable_kill_switch_fail_closed_refuses` |
| Delete only the check before the key | `step_inv`, all five `B2_0x_...`, `slow_first_attempt_is_reread`, the expiry examples |
| Stop comparing expiry in the re-check (undo the B5-05 fix) | `expiry_has_no_window`'s examples: both `B5_05_expiry_during_upload_...`, `expiry_shortly_after_admission_is_refused`, `expiry_has_no_failover_window`, `expiry_stops_the_failover_at_qualification`, and `the_code_rereads_every_stop` |
| Drop only the expiry check before a delegated visa's hold | only `B5_05_expiry_during_upload_opens_no_hold` |
| Force the authority reads at the send on a failover (would close finding 2) | only the two `failover_window_is_open...` theorems |

The last row is the one open decision (finding 2 above). It breaks only the
theorems that describe the gap, and nothing else. The expiry rows were re-run
after commit `944adc4`.

### How the proof is tied to the code

`tests/stop-checks-dispatch.test.ts` ports the model line for line and uses it
as the judge. It generates 700 seeded random traces: which stops, where they
land (before the request, during the upload, the approval wait, the hold, the
key lookup, the dispatch permission, the upstream call, on any attempt), how
much time passes (both sides of 2 seconds), 0 to 2 failovers, four kinds of
caller, both routes, both fail settings, Redis down, the mission store down,
the key database down, and a visa that expires mid-request. Each trace runs
through the real route. The route must:

- send exactly the attempts the model says it may, to the same hosts in the
  same order;
- open the same number of holds, resolve the same number of keys, release the
  same number of holds as "not dispatched", and leave no hold open;
- read the delegation, the mission and the Direct Agent Key exactly as many
  times as the model says, which checks the 2-second rule from the other side.

A failure prints the seed, the scenario, the model's trace and what the route
did. The run also checks it was not empty: every outcome the model can produce
was reached, including refusals at each of the three checks on first attempts
and on failovers, and both kinds of open window (first attempt and failover).

Three checks that the test can fail, run on 2026-11-13 before commit `944adc4`
and not repeated after it. With the model told that the re-check reads expiry,
it failed (the route then did not; it does now, and the model says so). With the
model told that the send check
forces the reads on a failover, it fails (the route does not). With the route's
forced failover read temporarily removed, which is the bug before the fix, it
fails on B2-03, B2-04 and B2-05; the route file was restored and is identical
to the commit.

Not exercised by the test: an unreadable suspend read (the harness replaces
that function, so its fail setting is proved from reading `redis.ts:653-667`
only), the injection-guard wait on the LLM route, a session stop reloaded from
the record, and the slow-last-check example in point 3 above. Redis, the
database, Telegram and the providers are stand-ins. The mission gate, the
delegation reader, the Direct Agent Key authenticator, the approval loop and
(when Redis is down) the kill reader are the real ones.

### How to re-check

```
cd proofs/stops && lake build
npx vitest run tests/stop-checks-dispatch.test.ts
```

Both pass as they are and with every private block deleted (the Lean files, and
the two routes plus the test).
