import Stops.Theorems
/-
  PassControl stop checks: the service proxy.

  Source of truth, read on 2026-11-10:
    app/api/v1/svc/[service]/[...path]/route.ts   lines 1-30 and 111-770
    lib/state/killswitch.ts                       readKillState (125-186), for `serviceKill`
    lib/gateway/authenticate.ts                   principalSuspended (245-251)

  The LLM route ends in one final gate. This route has none: every check is an
  early `return`. So it is modelled as what it is, an ordered list of checks,
  then the key read (step 7), more checks, then the send (step 8).

  WHERE THE MODEL SIMPLIFIES THE ROUTE (each one is a limit on what is proved):

  V1  Every check's ANSWER is an input: what the read or the helper would say if
      the route got that far. The helpers themselves are outside this model:
      `isServiceId`, `parseServicePath`, `authenticateGatewayRequest`,
      `enforceSenderConstraint`, `resolveCallMission`, `rateLimit`,
      `serviceRefusal`, `parseServiceRules`, `matchServiceRule`,
      `rateLimitFailClosed`, `readBoundedBody`, `forwardableUpstreamSearch`,
      `awaitApproval`, `existingApproval`, `entry.upstreamUrl`.
  V2  The exception is step 2. The kill read, the suspension fold and the gate
      are the SAME definitions the LLM route's proofs use (`readKillState`,
      `routeSuspended`, `evaluateGate`), extended with the per-service flag.
  V3  The route's `asks` and `askedBefore` (step 6c) are inputs. How they are
      computed from an `ask` rule, the injection guard's hold and the mission is
      not modelled.
  V4  A refusal keeps the check that made it. The HTTP status, the body, the
      audit row and the receipt are dropped.
  V5  `keyRead` means `get_provider_key` was CALLED. After it, the token is in
      memory only if the call returned one (`DecryptRead.token`).
  V6  The per-service flag is one Redis key per service. Here it is "the service
      is in the list of flagged services", which reads the same.
  V7  Step 9 (the answer, redaction, the receipt) is after the send and is not
      modelled. Nothing there can refuse a call that has not been sent.
-/

namespace Stops.Svc

open Stops

/-! ## The kill read, with the per-service flag (killswitch.ts:125-186) -/

/-- What Redis answered, plus the tenant's flagged services (V6). -/
structure SvcRedis where
  base : RedisKill
  services : List String
  deriving Repr

/-- `KillRead`, with what each branch knows about services. -/
inductive SvcKillRead where
  | redisFailed
  | loaded (r : SvcRedis)
  | recordFailed (r : SvcRedis)
  /-- `serviceStops`: the services with a `kind: "service"` record. -/
  | reloaded (r : SvcRedis) (tenantStop : Bool) (sessions : List (String × String))
      (serviceStops : List String)
  deriving Repr

/-- The same read, as the LLM route's model sees it. -/
def SvcKillRead.base : SvcKillRead → KillRead
  | .redisFailed => .redisFailed
  | .loaded r => .loaded r.base
  | .recordFailed r => .recordFailed r.base
  | .reloaded r t s _ => .reloaded r.base t s

/-- `serviceKill` as `readKillState(userId, { service })` returns it.
    It never reads the environment: no posture turns this flag on. -/
def readServiceKill (service : String) : SvcKillRead → Bool
  | .redisFailed => false                                       -- line 180
  | .loaded r => r.services.contains service                    -- line 142
  | .recordFailed r => r.services.contains service              -- lines 153-154
  | .reloaded r _ _ stops => r.services.contains service || stops.contains service  -- 164-166

/-! ## The route's inputs -/

/-- Which credential the call came in with (route.ts:133). -/
inductive Door where
  | passport | directKey
  deriving DecidableEq, Repr

/-- The service-rules read and what the parser and matcher said (step 5). -/
inductive RulesRead where
  /-- The read threw or returned an error (line 380). -/
  | unreadable
  /-- `parseServiceRules` said malformed (line 387). -/
  | malformed
  /-- No rules for this service (line 401, `!rules`). -/
  | noRules
  /-- Rules exist; `matched` is whether one admits this call (line 401). -/
  | rules (matched : Bool)
  deriving DecidableEq, Repr

/-- `rateLimitFailClosed` for the hourly cap (step 6). -/
inductive CapRead where
  | ok | exhausted | unreadable
  deriving DecidableEq, Repr

/-- `ApprovalOutcome` (lib/approvals/gate.ts:38). -/
inductive Approval where
  | approved | pending | denied | full | unavailable
  deriving DecidableEq, Repr

/-- What `get_provider_key` answered (step 7). -/
inductive DecryptRead where
  | failed | noToken | token
  deriving DecidableEq, Repr

structure Input where
  env : Env
  door : Door
  /-- The service named in the URL. -/
  service : String
  /-- `isServiceId(serviceRaw)`. -/
  knownService : Bool
  /-- `parsedPath.ok`. -/
  pathOk : Bool
  /-- `authentication.ok`. -/
  authenticated : Bool
  /-- `senderConstraint.ok`. Read only on the passport door. -/
  senderProofOk : Bool
  agentId : String
  /-- `lineage?.session ?? null`. -/
  sessionId : Option String
  /-- The Direct Agent Key's own `suspended`. Read only on that door. -/
  keySuspended : Bool
  killRead : SvcKillRead
  suspendRead : SuspendRead
  /-- `callMission.kind === "refuse"`. -/
  missionRefuses : Bool
  /-- `rl.success` (step 3). -/
  rateLimitOk : Bool
  /-- `serviceRefusal(...)` returned a reason (step 4, the never list). -/
  catalogRefuses : Bool
  rules : RulesRead
  cap : CapRead
  /-- `method !== "GET" && method !== "HEAD"`. -/
  isWrite : Bool
  /-- `!(contentType && !entry.bodyTypes.includes(mediaType))`. -/
  mediaTypeOk : Bool
  /-- `bounded.ok`. -/
  bodyWithinBound : Bool
  /-- `forwardableUpstreamSearch` did not throw. -/
  queryOk : Bool
  /-- The route's `asks` (V3). -/
  asks : Bool
  /-- The route's `askedBefore` (V3). -/
  askedBefore : Bool
  /-- `upstreamPath.length > APPROVAL_PATH_MAX`. -/
  pathTooLong : Bool
  /-- `preview.length > APPROVAL_PREVIEW_MAX`. -/
  previewTooLarge : Bool
  /-- What `awaitApproval` answers. -/
  awaited : Approval
  /-- What `existingApproval` answers; `none` is `{ state: "none" }`. -/
  existing : Option Approval
  decrypt : DecryptRead
  /-- `entry.upstreamUrl(token, ...)` returned a URL. -/
  tokenShapeOk : Bool
  deriving Repr

/-! ## Step 2: kill switch and suspension (route.ts:286-310) -/

/-- `kill`, without the service flag. -/
def killState (i : Input) : KillState := readKillState i.env i.killRead.base

/-- `kill.serviceKill === true`. -/
def serviceKill (i : Input) : Bool := readServiceKill i.service i.killRead

/-- `principalSuspended(principal)` (authenticate.ts:250). -/
def principalSuspended (i : Input) : Bool := i.door == .directKey && i.keySuspended

/-- The gate's `suspended` input (route.ts:296). -/
def suspended (i : Input) : Bool :=
  routeSuspended i.suspendRead (killState i) i.agentId i.sessionId (principalSuspended i)

/-- The gate input of route.ts:293-301. Scope, policy and budget are not
    supplied, so the gate stops after the suspension step. The endpoint facts
    are therefore never read; they are filled with a fixed value. -/
def revocationInput (i : Input) : GateInput :=
  { agentId := i.agentId
    killState := some (killState i)
    suspended := some (suspended i)
    scopes := none
    modelListing := false
    endpoint := ⟨true, false, false, false, false, false⟩
    policy := none
    policyFailClosed := false
    now := false
    policyRateLimit := none
    budget := none }

/-- The condition on route.ts:302. -/
def revocationRefuses (i : Input) : Bool :=
  decide ((evaluateGate (revocationInput i)).deniedBy = some .kill) ||
  decide ((evaluateGate (revocationInput i)).deniedBy = some .suspend) ||
  serviceKill i

/-! ## Step 6c: "Ask me first" (route.ts:539-648) -/

/-- The route's `approval` (line 587-606); `none` is `{ state: "none" }`. -/
def approvalState (i : Input) : Option Approval :=
  if i.asks then some i.awaited
  else if i.previewTooLarge || i.pathTooLong then none
  else i.existing

/-- `approval.state !== "approved" && approval.state !== "none"` (line 613). -/
def approvalHolds (i : Input) : Bool :=
  match approvalState i with
  | none => false
  | some .approved => false
  | some _ => true

/-! ## The checks -/

/-- One constructor per `return` that refuses, in the route's order. -/
inductive Check where
  | unknownService        -- line 116
  | invalidPath           -- line 127
  | authenticate          -- line 134   step 1
  | senderProof           -- line 152   step 1
  | revocation            -- line 309   step 2
  | mission               -- line 337   step 2b
  | rateLimit             -- line 344   step 3
  | catalog               -- line 355   step 4
  | rulesUnreadable       -- line 383   step 5
  | rulesMalformed        -- line 390   step 5
  | rulesNotAllowed       -- line 404   step 5
  | capUnreadable         -- line 457   step 6
  | capExhausted          -- line 467   step 6
  | mediaType             -- line 481   step 6b
  | bodyTooLarge          -- line 486   step 6b
  | invalidQuery          -- line 503
  | approvalPathTooLong   -- line 551   step 6c
  | approvalTooLarge      -- line 562   step 6c
  | approval              -- lines 619, 631, 635, 646   step 6c
  | credentialUnavailable -- line 664   step 7
  | noToken               -- line 668   step 7
  | tokenShape            -- line 692   step 7, before anything is spent
  deriving DecidableEq, Repr

/-- Does this check refuse, when the route reaches it? -/
def refuses (i : Input) : Check → Bool
  | .unknownService => !i.knownService
  | .invalidPath => !i.pathOk
  | .authenticate => !i.authenticated
  | .senderProof => i.door == .passport && !i.senderProofOk
  | .revocation => revocationRefuses i
  | .mission => i.missionRefuses
  | .rateLimit => !i.rateLimitOk
  | .catalog => i.catalogRefuses
  | .rulesUnreadable => i.rules == .unreadable
  | .rulesMalformed => i.rules == .malformed
  | .rulesNotAllowed => i.rules == .noRules || i.rules == .rules false
  | .capUnreadable => i.cap == .unreadable
  | .capExhausted => i.cap == .exhausted
  | .mediaType => i.isWrite && !i.mediaTypeOk
  | .bodyTooLarge => i.isWrite && !i.bodyWithinBound
  | .invalidQuery => !i.queryOk
  | .approvalPathTooLong => i.asks && i.pathTooLong
  | .approvalTooLarge => i.asks && (i.previewTooLarge || i.pathTooLong)
  | .approval => (i.asks || i.askedBefore) && approvalHolds i
  | .credentialUnavailable => i.decrypt == .failed
  | .noToken => i.decrypt == .noToken
  | .tokenShape => !i.tokenShapeOk

/-- Every check the route runs before `get_provider_key`, in order. -/
def beforeKey : List Check :=
  [ .unknownService, .invalidPath, .authenticate, .senderProof, .revocation, .mission,
    .rateLimit, .catalog, .rulesUnreadable, .rulesMalformed, .rulesNotAllowed,
    .capUnreadable, .capExhausted, .mediaType, .bodyTooLarge, .invalidQuery,
    .approvalPathTooLong, .approvalTooLarge, .approval ]

/-- Every check between `get_provider_key` and `fetch`, in order. -/
def afterKey : List Check :=
  [ .credentialUnavailable, .noToken, .tokenShape
    ]

/-- The first check in the list that refuses. -/
def firstRefusal (i : Input) : List Check → Option Check
  | [] => none
  | c :: rest => if refuses i c then some c else firstRefusal i rest

/-- What the route did (V4, V5). -/
structure Result where
  refusedBy : Option Check
  /-- `get_provider_key` was called. -/
  keyRead : Bool
  /-- `fetch(targetUrl)` was called. -/
  sent : Bool
  deriving DecidableEq, Repr

/-- route.ts `handle`, lines 111-763. -/
def route (i : Input) : Result :=
  match firstRefusal i beforeKey with
  | some c => { refusedBy := some c, keyRead := false, sent := false }
  | none =>
    match firstRefusal i afterKey with
    | some c => { refusedBy := some c, keyRead := true, sent := false }
    | none => { refusedBy := none, keyRead := true, sent := true }

/-! ## Lemmas -/

theorem firstRefusal_none (i : Input) (l : List Check) :
    firstRefusal i l = none ↔ ∀ c ∈ l, refuses i c = false := by
  induction l with
  | nil => simp [firstRefusal]
  | cons c rest ih =>
    simp only [firstRefusal]
    by_cases h : refuses i c = true
    · simp [h]
    · simp [h, ih]

theorem firstRefusal_some (i : Input) (l : List Check) (c : Check)
    (h : firstRefusal i l = some c) : c ∈ l ∧ refuses i c = true := by
  induction l with
  | nil => simp [firstRefusal] at h
  | cons d rest ih =>
    simp only [firstRefusal] at h
    by_cases hd : refuses i d = true
    · simp [hd] at h; subst h; simp [hd]
    · simp [hd] at h; have := ih h; simp [this]

/-! # HEADLINE THEOREMS

## 1. The order of the returns -/

/-- The key is read exactly when every check before step 7 passed. -/
theorem key_read_iff (i : Input) :
    (route i).keyRead = true ↔ ∀ c ∈ beforeKey, refuses i c = false := by
  rw [← firstRefusal_none]
  unfold route
  cases h : firstRefusal i beforeKey with
  | some c => simp
  | none => cases firstRefusal i afterKey <;> simp

/-- The call is sent exactly when every check passed, before and after the key. -/
theorem sent_iff (i : Input) :
    (route i).sent = true ↔ ∀ c ∈ beforeKey ++ afterKey, refuses i c = false := by
  have hsplit : (∀ c ∈ beforeKey ++ afterKey, refuses i c = false) ↔
      (firstRefusal i beforeKey = none ∧ firstRefusal i afterKey = none) := by
    rw [firstRefusal_none, firstRefusal_none]
    constructor
    · intro h
      exact ⟨fun c hc => h c (List.mem_append_left _ hc), fun c hc => h c (List.mem_append_right _ hc)⟩
    · rintro ⟨h1, h2⟩ c hc
      rcases List.mem_append.mp hc with hc | hc
      · exact h1 c hc
      · exact h2 c hc
  rw [hsplit]
  unfold route
  cases h : firstRefusal i beforeKey with
  | some c => simp
  | none => cases firstRefusal i afterKey <;> simp

/-- Nothing is sent without the key having been read. -/
theorem sent_needs_key (i : Input) (h : (route i).sent = true) : (route i).keyRead = true := by
  unfold route at *
  cases h1 : firstRefusal i beforeKey with
  | some c => simp [h1] at h
  | none => cases h2 : firstRefusal i afterKey <;> simp

/-- A REFUSAL BEFORE STEP 7 NEVER REACHES THE KEY. If any check before the key
    read refuses, the key is not read and nothing is sent, whatever every other
    input is. -/
theorem refusal_before_key (i : Input) (c : Check) (hc : c ∈ beforeKey)
    (h : refuses i c = true) : (route i).keyRead = false ∧ (route i).sent = false := by
  have hk : (route i).keyRead = false := by
    cases hkr : (route i).keyRead
    · rfl
    · have := (key_read_iff i).mp hkr c hc; simp [h] at this
  refine ⟨hk, ?_⟩
  cases hs : (route i).sent
  · rfl
  · have := sent_needs_key i hs; simp [hk] at this

/-- A refusal after the key read: the key was read, the call was not sent. -/
theorem refusal_after_key (i : Input) (c : Check) (h : (route i).refusedBy = some c)
    (hc : c ∈ afterKey) (hdisj : c ∉ beforeKey) :
    (route i).keyRead = true ∧ (route i).sent = false := by
  unfold route at *
  cases h1 : firstRefusal i beforeKey with
  | some d =>
    simp [h1] at h; subst h
    exact absurd (firstRefusal_some i _ _ h1).1 hdisj
  | none => cases h2 : firstRefusal i afterKey <;> simp [h1, h2] at h ⊢

/-- The check named in a refusal did refuse, and it is one the route runs. -/
theorem refused_by_refuses (i : Input) (c : Check) (h : (route i).refusedBy = some c) :
    c ∈ beforeKey ++ afterKey ∧ refuses i c = true := by
  unfold route at h
  cases h1 : firstRefusal i beforeKey with
  | some d =>
    simp [h1] at h; subst h
    have := firstRefusal_some i _ _ h1
    exact ⟨List.mem_append_left _ this.1, this.2⟩
  | none =>
    cases h2 : firstRefusal i afterKey with
    | none => simp [h1, h2] at h
    | some d =>
      simp [h1, h2] at h; subst h
      have := firstRefusal_some i _ _ h2
      exact ⟨List.mem_append_right _ this.1, this.2⟩

/-- Sent means nothing refused, and the reverse. -/
theorem sent_iff_not_refused (i : Input) : (route i).sent = true ↔ (route i).refusedBy = none := by
  unfold route
  cases firstRefusal i beforeKey with
  | some c => simp
  | none => cases firstRefusal i afterKey <;> simp

/-! ## 2. Step 2 is the LLM route's revocation check, plus the service flag -/

/-- Line 302 refuses exactly: a kill control, a suspension, or this service's kill. -/
theorem revocation_refuses_iff (i : Input) :
    revocationRefuses i = true ↔
      (isBlocked (killState i) i.agentId = true ∨ suspended i = true ∨ serviceKill i = true) := by
  have h := revocation_gate_refuses_exactly (revocationInput i) (killState i) (suspended i) rfl rfl
  simp only [revocationRefuses, Bool.or_eq_true, decide_eq_true_eq]
  constructor
  · rintro ((hg | hg) | hs)
    · rcases h.mp (Or.inl hg) with hb | hsus
      · exact Or.inl hb
      · exact Or.inr (Or.inl hsus)
    · rcases h.mp (Or.inr hg) with hb | hsus
      · exact Or.inl hb
      · exact Or.inr (Or.inl hsus)
    · exact Or.inr (Or.inr hs)
  · rintro (hb | hsus | hs)
    · exact Or.inl (h.mpr (Or.inl hb))
    · exact Or.inl (h.mpr (Or.inr hsus))
    · exact Or.inr hs

theorem revocation_mem : Check.revocation ∈ beforeKey := by simp [beforeKey]

/-- Any stop that step 2 sees keeps the call from the key. -/
theorem revoked_never_reaches_key (i : Input)
    (h : isBlocked (killState i) i.agentId = true ∨ suspended i = true ∨ serviceKill i = true) :
    (route i).keyRead = false ∧ (route i).sent = false :=
  refusal_before_key i .revocation revocation_mem
    (by simpa [refuses] using (revocation_refuses_iff i).mpr h)

/-- THE PER-SERVICE KILL DENIES ON ITS OWN, whatever every other input is. -/
theorem service_kill_denies (i : Input) (h : serviceKill i = true) :
    (route i).keyRead = false ∧ (route i).sent = false :=
  revoked_never_reaches_key i (Or.inr (Or.inr h))

/-- A flag Redis holds for this service is seen whenever Redis answers, under
    either posture. -/
theorem service_flag_in_redis_is_seen (service : String) (r : SvcRedis)
    (h : r.services.contains service = true) (t : Bool) (s : List (String × String))
    (stops : List String) :
    readServiceKill service (.loaded r) = true ∧
    readServiceKill service (.recordFailed r) = true ∧
    readServiceKill service (.reloaded r t s stops) = true := by
  have h' : service ∈ r.services := by simpa using h
  simp [readServiceKill, h']

/-- A service stop that is only in the record is seen when the record reloads. -/
theorem service_stop_in_record_is_seen (service : String) (r : SvcRedis) (t : Bool)
    (s : List (String × String)) (stops : List String) (h : stops.contains service = true) :
    readServiceKill service (.reloaded r t s stops) = true := by
  have h' : service ∈ stops := by simpa using h
  simp [readServiceKill, h']

/-- IT DENIES ONLY THE SERVICE IT NAMES. If the flag is on, the service asked
    about is among the flagged or recorded ones. -/
theorem service_kill_names_its_service (service : String) (read : SvcKillRead)
    (h : readServiceKill service read = true) :
    match read with
    | .redisFailed => False
    | .loaded r => service ∈ r.services
    | .recordFailed r => service ∈ r.services
    | .reloaded r _ _ stops => service ∈ r.services ∨ service ∈ stops := by
  cases read with
  | redisFailed => simp [readServiceKill] at h
  | loaded r => simpa [readServiceKill] using h
  | recordFailed r => simpa [readServiceKill] using h
  | reloaded r _ _ stops => simpa [readServiceKill] using h

/-- So a stop on another service leaves this one's flag off. -/
theorem other_service_kill_is_not_this_one (service other : String) (hne : service ≠ other)
    (base : RedisKill) (t : Bool) (s : List (String × String)) :
    readServiceKill service (.loaded ⟨base, [other]⟩) = false ∧
    readServiceKill service (.reloaded ⟨base, [other]⟩ t s [other]) = false := by
  simp [readServiceKill, hne]

/-- The flag never reads the environment. -/
theorem service_flag_ignores_posture (i : Input) (env : Env) :
    serviceKill { i with env := env } = serviceKill i := rfl

/-- POSTURE, REDIS UNREADABLE, FAIL-OPEN (the code default). The service flag
    reads off and no kill control reads on: a per-service stop is NOT enforced
    while Redis cannot be read. Step 2 then refuses only on suspension. -/
theorem service_kill_redis_failed_open (i : Input) (hr : i.killRead = .redisFailed)
    (he : i.env.killClosed = false) :
    serviceKill i = false ∧ isBlocked (killState i) i.agentId = false ∧
    (revocationRefuses i = true ↔ suspended i = true) := by
  have h1 : serviceKill i = false := by simp [serviceKill, hr, readServiceKill]
  have h2 : isBlocked (killState i) i.agentId = false := by
    simp [killState, hr, SvcKillRead.base, readKillState, he, isBlocked]
  refine ⟨h1, h2, ?_⟩
  rw [revocation_refuses_iff]; simp [h1, h2]

/-- POSTURE, REDIS UNREADABLE, FAIL-CLOSED. Every service call is refused before
    the key, through the platform flag. -/
theorem service_kill_redis_failed_closed (i : Input) (hr : i.killRead = .redisFailed)
    (he : i.env.killClosed = true) :
    (route i).keyRead = false ∧ (route i).sent = false :=
  revoked_never_reaches_key i
    (Or.inl (by simp [killState, hr, SvcKillRead.base, readKillState, he, isBlocked]))

/-- POSTURE, RECORD UNREADABLE, FAIL-OPEN. What Redis holds still counts, and
    nothing more: a service stop that survives only in the record is NOT
    enforced. -/
theorem service_kill_record_failed_open (i : Input) (r : SvcRedis)
    (hr : i.killRead = .recordFailed r) (he : i.env.killClosed = false) :
    serviceKill i = r.services.contains i.service ∧ killState i = r.base.state := by
  simp [serviceKill, killState, hr, readServiceKill, SvcKillRead.base, readKillState, he]

/-- POSTURE, RECORD UNREADABLE, FAIL-CLOSED. Refused before the key. -/
theorem service_kill_record_failed_closed (i : Input) (r : SvcRedis)
    (hr : i.killRead = .recordFailed r) (he : i.env.killClosed = true) :
    (route i).keyRead = false ∧ (route i).sent = false :=
  revoked_never_reaches_key i
    (Or.inl (by simp [killState, hr, SvcKillRead.base, readKillState, he, isBlocked]))

/-! ## 3. The checks that fail closed -/

/-- AN UNREADABLE RULES ROW NEVER REACHES THE KEY, under any environment. -/
theorem unreadable_rules_never_reach_key (i : Input) (h : i.rules = .unreadable) (env : Env) :
    (route { i with env := env }).keyRead = false ∧ (route { i with env := env }).sent = false :=
  refusal_before_key _ .rulesUnreadable (by simp [beforeKey]) (by simp [refuses, h])

/-- AN UNREADABLE HOURLY COUNTER NEVER REACHES THE KEY, under any environment. -/
theorem unreadable_cap_never_reaches_key (i : Input) (h : i.cap = .unreadable) (env : Env) :
    (route { i with env := env }).keyRead = false ∧ (route { i with env := env }).sent = false :=
  refusal_before_key _ .capUnreadable (by simp [beforeKey]) (by simp [refuses, h])

/-- Neither check reads the environment at all, and neither do the other checks
    from step 3 on. Only step 2 does, through the kill read. -/
theorem only_step_two_reads_posture (i : Input) (env : Env) (c : Check) (h : c ≠ .revocation) :
    refuses { i with env := env } c = refuses i c := by
  cases c <;> first | rfl | exact absurd rfl h

/-- Rules that are missing, malformed or do not admit the call: no key. -/
theorem unadmitted_rules_never_reach_key (i : Input)
    (h : i.rules = .malformed ∨ i.rules = .noRules ∨ i.rules = .rules false) :
    (route i).keyRead = false ∧ (route i).sent = false := by
  rcases h with h | h | h
  · exact refusal_before_key i .rulesMalformed (by simp [beforeKey]) (by simp [refuses, h])
  · exact refusal_before_key i .rulesNotAllowed (by simp [beforeKey]) (by simp [refuses, h])
  · exact refusal_before_key i .rulesNotAllowed (by simp [beforeKey]) (by simp [refuses, h])

/-- An exhausted hourly cap: no key. -/
theorem exhausted_cap_never_reaches_key (i : Input) (h : i.cap = .exhausted) :
    (route i).keyRead = false ∧ (route i).sent = false :=
  refusal_before_key i .capExhausted (by simp [beforeKey]) (by simp [refuses, h])

/-- The catalog's never list: no key, whatever the rules say. -/
theorem never_list_never_reaches_key (i : Input) (h : i.catalogRefuses = true) :
    (route i).keyRead = false ∧ (route i).sent = false :=
  refusal_before_key i .catalog (by simp [beforeKey]) (by simp [refuses, h])

/-- "Ask me first": a call that asks reaches the key only once approved. -/
theorem asked_call_needs_approval (i : Input) (ha : i.asks = true)
    (hk : (route i).keyRead = true) : i.awaited = .approved := by
  have h := (key_read_iff i).mp hk .approval (by simp [beforeKey])
  simp only [refuses, ha, Bool.true_or, Bool.true_and, approvalHolds, approvalState, ite_true] at h
  cases hw : i.awaited <;> simp [hw] at h ⊢

/-! ## 4. Both doors -/

/-- BOTH DOORS RUN THE SAME STOP CHECKS. Apart from the sender proof (a passport
    has one, a Direct Agent Key does not) and step 2, no check's answer depends
    on the door. -/
theorem door_does_not_change_checks (i : Input) (d : Door) (c : Check)
    (h1 : c ≠ .senderProof) (h2 : c ≠ .revocation) :
    refuses { i with door := d } c = refuses i c := by
  cases c <;> first | rfl | exact absurd rfl h1 | exact absurd rfl h2

/-- At step 2 the Direct Agent Key door only ADDS a stop (the key's own
    suspended agent): whatever refuses a passport refuses a direct key. -/
theorem direct_key_revocation_is_no_weaker (i : Input)
    (h : revocationRefuses { i with door := .passport } = true) :
    revocationRefuses { i with door := .directKey } = true := by
  rw [revocation_refuses_iff] at h ⊢
  rcases h with h | h | h
  · exact Or.inl h
  · refine Or.inr (Or.inl ?_)
    simp only [suspended, routeSuspended, Bool.or_eq_true] at h ⊢
    rcases h with h | h
    · exact Or.inl h
    · simp [principalSuspended] at h
  · exact Or.inr (Or.inr h)

/-- With the key's agent not suspended, step 2 answers the same on both doors. -/
theorem doors_agree_at_revocation (i : Input) (d : Door) (h : i.keySuspended = false) :
    revocationRefuses { i with door := d } = revocationRefuses i := by
  have hp : ∀ j : Input, j.keySuspended = false → principalSuspended j = false := by
    intro j hj; simp [principalSuspended, hj]
  have e1 := hp { i with door := d } h
  have e2 := hp i h
  simp only [revocationRefuses, revocationInput, suspended, e1, e2, killState, serviceKill]

/-- A Direct Agent Key whose agent is suspended is refused before the key. -/
theorem suspended_direct_key_never_reaches_key (i : Input) (hd : i.door = .directKey)
    (hs : i.keySuspended = true) : (route i).keyRead = false ∧ (route i).sent = false :=
  revoked_never_reaches_key i
    (Or.inr (Or.inl (by simp [suspended, routeSuspended, principalSuspended, hd, hs])))

/-- Every stop, on either door: if a check before the key refuses, no key. -/
theorem every_stop_holds_on_both_doors (i : Input) (d : Door) (c : Check) (hc : c ∈ beforeKey)
    (h : refuses { i with door := d } c = true) :
    (route { i with door := d }).keyRead = false ∧ (route { i with door := d }).sent = false :=
  refusal_before_key _ c hc h

/-! ## The refusals after the key read -/

/-- A failed key read or an empty answer: the RPC was called, no token came
    back, nothing is sent. -/
theorem no_token_is_not_sent (i : Input) (h : i.decrypt ≠ .token) : (route i).sent = false := by
  cases hs : (route i).sent
  · rfl
  · have hall := (sent_iff i).mp hs
    have h1 := hall .credentialUnavailable (by simp [beforeKey, afterKey])
    have h2 := hall .noToken (by simp [beforeKey, afterKey])
    simp only [refuses] at h1 h2
    cases hd : i.decrypt <;> simp_all


end Stops.Svc
