/-
  PassControl stop checks: the model.

  Source of truth, read on 2026-11-10:
    lib/gate.ts                    evaluateGate (lines 179-509)
    lib/state/killswitch.ts        readKillState (125-186), withRecordedSessionStop
                                   (224-235), isBlocked (252-254)
    app/api/v1/[provider]/[...path]/route.ts
                                   lines 1187-1193 (how the route folds its reads
                                   into the gate's `suspended` input) and 2452
                                   (how it reads POLICY_FAIL_CLOSED)

  The gate is a pure function. It is modelled here as the same function.

  WHERE THE MODEL SIMPLIFIES THE CODE (each one is a limit on what is proved):

  S1  Four checks are answered by functions outside the files above. Their
      ANSWERS are inputs here, not their workings:
        scope     `scopeRuleMatch` (lib/scope.ts): did a visa rule match, and
                  did the sub-agent list match.
        endpoint  `endpointAllows`, `isOpenRouterModelRouter`,
                  `isServerSideSearchModel`, `providerRequiresEndpoint`,
                  `hasListedPrice`, `isLivePricedProvider`.
        policy    `evaluateAgentPolicy`: allowed or not, hourly limit or none.
        budget    the atomic reserve's `ok`.
      So nothing here says those functions are right. It says what the gate
      does with each answer they can give.
  S2  A step result keeps its name, its status and, on a failure, its rule.
      The human-readable reason, the HTTP status and the "warning" marker are
      dropped. No decision reads them.
  S3  Agent and session ids are strings, compared for equality, as in the code.
  S4  `readKillState` is modelled from the point where Redis has answered or
      failed. What Redis and the Postgres record returned is an input
      (`KillRead`). The reload itself (`reloadFromRecord`, which also writes the
      flags back to Redis) is not modelled.
  S5  The environment is the two variables the gateway reads, each unset or a
      string.
  S6  `isSuspended` (lib/state/redis.ts) is outside the files above. Only its
      result is an input (`SuspendRead`).
-/

namespace Stops

/-! ## lib/gate.ts -/

/-- `GateStepName` (gate.ts:22). -/
inductive Step where
  | kill | suspend | scope | endpoint | policy | budget
  deriving DecidableEq, Repr

/-- The order `evaluateGate` runs the steps in (gate.ts:163). -/
def order : List Step := [.kill, .suspend, .scope, .endpoint, .policy, .budget]

/-- A step's place in that order. -/
def Step.rank : Step → Nat
  | .kill => 0 | .suspend => 1 | .scope => 2 | .endpoint => 3 | .policy => 4 | .budget => 5

/-- The `rule` a failing step records. One constructor per `fail(...)` call. -/
inductive Rule where
  | killPlatform | killTenant | killDenylist
  | suspendActive
  | scopeNoMatch | scopeSubagentNoMatch
  | endpointNoMatch | endpointModelRouter | endpointSearchModel
  | endpointUnpricedEndpoint | endpointUnpricedModel
  | policyUnreadable | policyRule | policyHourly
  | budgetCap
  deriving DecidableEq, Repr

/-- `KillState` (killswitch.ts:100). `serviceKill` is left out: only the service
    route asks for it, and the model route never reads it. -/
structure KillState where
  platformKill : Bool
  userKill : Bool
  denylist : List String
  /-- (agentId, sessionId) pairs, present only on the call that reloaded them. -/
  recordedSessionStops : List (String × String) := []
  deriving DecidableEq, Repr

/-- `isBlocked` (killswitch.ts:252). -/
def isBlocked (st : KillState) (agentId : String) : Bool :=
  st.platformKill || st.userKill || st.denylist.contains agentId

/-- What `scopeRuleMatch` answered (S1). -/
structure ScopeFacts where
  /-- `scopeRuleMatch(scopes, provider, model)` found a rule. -/
  ruleMatch : Bool
  /-- `input.subagent && input.subagent.allow !== null`. -/
  subagentRestricted : Bool
  /-- `scopeRuleMatch(input.subagent.allow, provider, model)` found a rule. -/
  subagentMatch : Bool
  deriving DecidableEq, Repr

/-- What the endpoint helpers answered (S1). -/
structure EndpointFacts where
  /-- `endpointIsAllowed(input)`. -/
  allowed : Bool
  /-- `provider === "openrouter" && isOpenRouterModelRouter(model)`. -/
  modelRouter : Bool
  /-- `isServerSideSearchModel(provider, model)`. -/
  searchModel : Bool
  /-- `input.dollarLimited === true`. -/
  dollarLimited : Bool
  /-- `isProvider(provider) && providerRequiresEndpoint(provider)`. -/
  requiresEndpoint : Bool
  /-- `isProvider(provider) && !isLivePricedProvider(provider) && !hasListedPrice(model, provider)`. -/
  unpricedModel : Bool
  deriving DecidableEq, Repr

/-- What `evaluateAgentPolicy` answered (S1). -/
structure PolicyDecision where
  allowed : Bool
  /-- `decision.maxRequestsPerHour !== null`. -/
  hourly : Bool
  deriving DecidableEq, Repr

/-- `GatePolicyInput` (gate.ts:36). -/
inductive PolicyInput where
  | unreadable
  | value (decision : PolicyDecision)
  deriving DecidableEq, Repr

/-- `GateRateLimitInput` (gate.ts:40). `unreadable` absent reads as false. -/
structure RateLimit where
  success : Bool
  unreadable : Bool
  deriving DecidableEq, Repr

/-- `GateInput` (gate.ts:71). `none` is the code's `undefined`: not read yet. -/
structure GateInput where
  agentId : String
  killState : Option KillState
  suspended : Option Bool
  scopes : Option ScopeFacts
  /-- `isModelListing(input.path)`. -/
  modelListing : Bool
  endpoint : EndpointFacts
  policy : Option PolicyInput
  /-- `input.policyFailClosed === true`. -/
  policyFailClosed : Bool
  /-- `input.now !== undefined`. -/
  now : Bool
  policyRateLimit : Option RateLimit
  /-- `input.budget.ok`. -/
  budget : Option Bool
  deriving Repr

/-- What one step decides when it is reached.
    `wait`   an input is missing: the step is skipped and the chain is pending.
    `exempt` the step is skipped and the chain goes on (scope, on a model listing). -/
inductive Outcome where
  | pass
  | fail (rule : Rule)
  | wait
  | exempt
  deriving DecidableEq, Repr

/-- The chain goes on after this outcome. -/
def Outcome.clears : Outcome → Bool
  | .pass => true
  | .exempt => true
  | _ => false

def Outcome.isFail : Outcome → Bool
  | .fail _ => true
  | _ => false

def Outcome.isWait : Outcome → Bool
  | .wait => true
  | _ => false

/-- gate.ts:208-229. -/
def killOutcome (i : GateInput) : Outcome :=
  match i.killState with
  | none => .wait
  | some st =>
    if st.platformKill then .fail .killPlatform
    else if st.userKill then .fail .killTenant
    else if st.denylist.contains i.agentId then .fail .killDenylist
    else .pass

/-- gate.ts:231-247. -/
def suspendOutcome (i : GateInput) : Outcome :=
  match i.suspended with
  | none => .wait
  | some true => .fail .suspendActive
  | some false => .pass

/-- gate.ts:249-284. -/
def scopeOutcome (i : GateInput) : Outcome :=
  match i.scopes with
  | none => .wait
  | some s =>
    if i.modelListing then .exempt
    else if !s.ruleMatch then .fail .scopeNoMatch
    else if s.subagentRestricted && !s.subagentMatch then .fail .scopeSubagentNoMatch
    else .pass

/-- gate.ts:286-367. This step has no missing-input case. -/
def endpointOutcome (i : GateInput) : Outcome :=
  if !i.endpoint.allowed then .fail .endpointNoMatch
  else if i.endpoint.modelRouter then .fail .endpointModelRouter
  else if i.endpoint.searchModel then .fail .endpointSearchModel
  else if i.endpoint.dollarLimited && i.endpoint.requiresEndpoint then .fail .endpointUnpricedEndpoint
  else if i.endpoint.dollarLimited && !i.modelListing && i.endpoint.unpricedModel then
    .fail .endpointUnpricedModel
  else .pass

/-- gate.ts:369-466. -/
def policyOutcome (i : GateInput) : Outcome :=
  match i.policy with
  | none => .wait
  | some .unreadable => if i.policyFailClosed then .fail .policyUnreadable else .pass
  | some (.value d) =>
    if !i.now then .wait
    else if !d.allowed then .fail .policyRule
    else if d.hourly then
      match i.policyRateLimit with
      | none => .wait
      | some rl =>
        if rl.success then .pass
        else if rl.unreadable then .pass
        else .fail .policyHourly
    else .pass

/-- gate.ts:468-499. -/
def budgetOutcome (i : GateInput) : Outcome :=
  match i.budget with
  | none => .wait
  | some true => .pass
  | some false => .fail .budgetCap

def outcome : Step → GateInput → Outcome
  | .kill => killOutcome
  | .suspend => suspendOutcome
  | .scope => scopeOutcome
  | .endpoint => endpointOutcome
  | .policy => policyOutcome
  | .budget => budgetOutcome

/-- `GateStepStatus` (gate.ts:23). -/
inductive Status where
  | pass | fail | skipped
  deriving DecidableEq, Repr

/-- `GateStepResult` (gate.ts:25), reduced as S2 says. -/
structure StepResult where
  name : Step
  status : Status
  rule : Option Rule
  deriving DecidableEq, Repr

/-- The three locals `evaluateGate` carries: `deniedBy`, `pending`, `steps`. -/
structure Acc where
  deniedBy : Option Step
  pending : Bool
  steps : List StepResult
  deriving Repr

/-- The start of `evaluateGate` (gate.ts:180-182). -/
def Acc.start : Acc := { deniedBy := none, pending := false, steps := [] }

/-- `deniedBy || pending`: the test every step after the first opens with. -/
def Acc.stopped (a : Acc) : Bool := a.deniedBy.isSome || a.pending

/-- One step of the chain. Stopped: `afterStop` records a skip and nothing else
    changes. Otherwise the step's own outcome is recorded. -/
def Acc.apply (a : Acc) (s : Step) (o : Outcome) : Acc :=
  if a.stopped then { a with steps := a.steps ++ [⟨s, .skipped, none⟩] }
  else
    match o with
    | .pass => { a with steps := a.steps ++ [⟨s, .pass, none⟩] }
    | .fail r => { a with steps := a.steps ++ [⟨s, .fail, some r⟩], deniedBy := some s }
    | .wait => { a with steps := a.steps ++ [⟨s, .skipped, none⟩], pending := true }
    | .exempt => { a with steps := a.steps ++ [⟨s, .skipped, none⟩] }

def run (i : GateInput) : List Step → Acc → Acc
  | [], a => a
  | s :: rest, a => run i rest (a.apply s (outcome s i))

inductive Verdict where
  | allow | deny
  deriving DecidableEq, Repr

/-- `GateEvaluation` (gate.ts:116), reduced as S2 says. -/
structure GateEvaluation where
  verdict : Verdict
  deniedBy : Option Step
  complete : Bool
  steps : List StepResult
  deriving Repr

/-- gate.ts:179-509. -/
def evaluateGate (i : GateInput) : GateEvaluation :=
  let a := run i order Acc.start
  { verdict := if a.deniedBy.isSome then .deny else .allow
    deniedBy := a.deniedBy
    complete := !a.pending
    steps := a.steps }

/-- The gate lets the call through: it denied nothing AND it looked at everything.
    `verdict = allow` alone is weaker: the gate also says "allow" when it stopped
    early on a missing input (see `allow_alone_is_not_admission`). -/
def admits (i : GateInput) : Prop :=
  (evaluateGate i).verdict = .allow ∧ (evaluateGate i).complete = true

/-! ## lib/state/killswitch.ts and route.ts 1187-1193 -/

/-- The result of `isSuspended(agentId, sessionId)`: `false`, `true`, `"session"`. -/
inductive SuspendRead where
  | no | agent | session
  deriving DecidableEq, Repr

/-- `withRecordedSessionStop` (killswitch.ts:224-235).
    `sessionId` is `none` for null or undefined. An empty string is falsy in the
    code, so it also returns the read unchanged. -/
def withRecordedSessionStop (read : SuspendRead) (st : KillState) (agentId : String)
    (sessionId : Option String) : SuspendRead :=
  match read, sessionId with
  | .no, some sid =>
    if sid = "" then .no
    else if st.recordedSessionStops.any (fun stop => stop.1 == agentId && stop.2 == sid) then .session
    else .no
  | r, _ => r

/-- The gate's `suspended` input as the route computes it (route.ts:1191-1193):
    `redisSuspended !== false || principalSuspended(principal)`. -/
def routeSuspended (read : SuspendRead) (st : KillState) (agentId : String)
    (sessionId : Option String) (principalSuspended : Bool) : Bool :=
  (withRecordedSessionStop read st agentId sessionId != .no) || principalSuspended

/-! ## The fail-posture variables -/

/-- `process.env`, the two variables only (S5). `none` is unset. -/
structure Env where
  killSwitchFailClosed : Option String
  policyFailClosed : Option String
  deriving DecidableEq, Repr


/-- `process.env.KILL_SWITCH_FAIL_CLOSED === "true"` (killswitch.ts:153 and 181). -/
def Env.killClosed (env : Env) : Bool := env.killSwitchFailClosed == some "true"

/-- `process.env.POLICY_FAIL_CLOSED === "true"` (route.ts:2452). -/
def Env.policyClosed (env : Env) : Bool := env.policyFailClosed == some "true"


/-- An environment with neither variable set: the code default. -/
def defaultEnv : Env := { killSwitchFailClosed := none, policyFailClosed := none }

/-! ## readKillState (killswitch.ts:125-186) -/

/-- What Redis answered: the platform flag, the tenant flag, the denylist. -/
structure RedisKill where
  platform : Bool
  tenant : Bool
  denylist : List String
  deriving DecidableEq, Repr

/-- The state built from Redis alone (killswitch.ts:138-143). -/
def RedisKill.state (r : RedisKill) : KillState :=
  { platformKill := r.platform, userKill := r.tenant, denylist := r.denylist }

/-- Everything that can happen inside `readKillState` (S4). -/
inductive KillRead where
  /-- The Redis read threw (the outer `catch`, line 171). -/
  | redisFailed
  /-- Redis answered and the tenant's stops are loaded, or there is no tenant (line 144). -/
  | loaded (r : RedisKill)
  /-- Redis answered, the stops were not loaded, and the record could not be read (149-155). -/
  | recordFailed (r : RedisKill)
  /-- Redis answered, the stops were not loaded, and the record was read (156-170). -/
  | reloaded (r : RedisKill) (tenantStop : Bool) (sessions : List (String × String))
  deriving Repr

/-- `readKillState`, from the read's result to the state it returns. -/
def readKillState (env : Env) : KillRead → KillState
  | .redisFailed =>
    if env.killClosed then { platformKill := true, userKill := false, denylist := [] }
    else { platformKill := false, userKill := false, denylist := [] }
  | .loaded r => r.state
  | .recordFailed r => if env.killClosed then { r.state with platformKill := true } else r.state
  | .reloaded r tenantStop sessions =>
    { r.state with userKill := r.tenant || tenantStop, recordedSessionStops := sessions }

end Stops
