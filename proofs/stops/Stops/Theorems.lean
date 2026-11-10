import Stops.Model

/-
  PassControl stop checks: the theorems.

  Every statement is about `evaluateGate` and the functions around it as
  modelled in `Stops/Model.lean`, for EVERY input. Nothing here is sampled.
-/

namespace Stops

/-! ## How the chain runs (lemmas) -/

/-- The first step in a list whose outcome stops the chain. -/
def firstStop (i : GateInput) : List Step → Option Step
  | [] => none
  | s :: rest => if (outcome s i).clears then firstStop i rest else some s

theorem forall_step {Q : Step → Prop} :
    (∀ t, Q t) ↔ Q .kill ∧ Q .suspend ∧ Q .scope ∧ Q .endpoint ∧ Q .policy ∧ Q .budget :=
  ⟨fun h => ⟨h _, h _, h _, h _, h _, h _⟩,
   fun ⟨a, b, c, d, e, f⟩ t => by cases t <;> assumption⟩

theorem isFail_iff (o : Outcome) : o.isFail = true ↔ ∃ r, o = .fail r := by
  cases o <;> simp [Outcome.isFail]

theorem not_clears (o : Outcome) (h : o.clears = false) : o.isFail = true ∨ o.isWait = true := by
  cases o <;> simp_all [Outcome.clears, Outcome.isFail, Outcome.isWait]

theorem fail_not_clears (o : Outcome) (h : o.isFail = true) : o.clears = false := by
  cases o <;> simp_all [Outcome.clears, Outcome.isFail]

theorem wait_not_fail (o : Outcome) (h : o.isWait = true) : o.isFail = false := by
  cases o <;> simp_all [Outcome.isWait, Outcome.isFail]

/-- Once the chain has stopped, no later step changes `deniedBy` or `pending`. -/
theorem run_stopped (i : GateInput) (l : List Step) (a : Acc) (h : a.stopped = true) :
    (run i l a).deniedBy = a.deniedBy ∧ (run i l a).pending = a.pending := by
  induction l generalizing a with
  | nil => simp [run]
  | cons s rest ih =>
    have e : a.apply s (outcome s i) = { a with steps := a.steps ++ [⟨s, .skipped, none⟩] } := by
      simp [Acc.apply, h]
    rw [run, e]
    exact ih _ (by simpa [Acc.stopped] using h)

/-- What the chain leaves in `deniedBy` and `pending`, from a start that has not stopped. -/
theorem run_spec (i : GateInput) (l : List Step) (a : Acc) (h : a.stopped = false) :
    (run i l a).deniedBy =
        (match firstStop i l with
          | some s => if (outcome s i).isFail then some s else none
          | none => none) ∧
      (run i l a).pending =
        (match firstStop i l with
          | some s => (outcome s i).isWait
          | none => false) := by
  induction l generalizing a with
  | nil =>
    simp only [Acc.stopped, Bool.or_eq_false_iff] at h
    cases hd : a.deniedBy <;> simp_all [run, firstStop]
  | cons s rest ih =>
    have hs := h
    simp only [Acc.stopped, Bool.or_eq_false_iff] at hs
    cases ho : outcome s i with
    | pass =>
      have e : a.apply s .pass = { a with steps := a.steps ++ [⟨s, .pass, none⟩] } := by
        simp [Acc.apply, h]
      have := ih { a with steps := a.steps ++ [⟨s, .pass, none⟩] } (by simpa [Acc.stopped] using h)
      simpa [run, firstStop, ho, e, Outcome.clears] using this
    | exempt =>
      have e : a.apply s .exempt = { a with steps := a.steps ++ [⟨s, .skipped, none⟩] } := by
        simp [Acc.apply, h]
      have := ih { a with steps := a.steps ++ [⟨s, .skipped, none⟩] } (by simpa [Acc.stopped] using h)
      simpa [run, firstStop, ho, e, Outcome.clears] using this
    | fail r =>
      have e : a.apply s (.fail r) =
          { a with steps := a.steps ++ [⟨s, .fail, some r⟩], deniedBy := some s } := by
        simp [Acc.apply, h]
      have := run_stopped i rest
        { a with steps := a.steps ++ [⟨s, .fail, some r⟩], deniedBy := some s } (by simp [Acc.stopped])
      simp only [hs.2] at this
      simp [run, firstStop, ho, e, Outcome.clears, Outcome.isFail, Outcome.isWait, this, hs.2]
    | wait =>
      have e : a.apply s .wait =
          { a with steps := a.steps ++ [⟨s, .skipped, none⟩], pending := true } := by
        simp [Acc.apply, h]
      have := run_stopped i rest
        { a with steps := a.steps ++ [⟨s, .skipped, none⟩], pending := true } (by simp [Acc.stopped])
      have hn : a.deniedBy = none := by
        cases hd : a.deniedBy <;> simp_all
      simp only [hn] at this
      simp [run, firstStop, ho, e, Outcome.clears, Outcome.isFail, Outcome.isWait, this, hn]

theorem gate_deniedBy (i : GateInput) :
    (evaluateGate i).deniedBy =
      (match firstStop i order with
        | some s => if (outcome s i).isFail then some s else none
        | none => none) :=
  (run_spec i order Acc.start rfl).1

theorem gate_complete (i : GateInput) :
    (evaluateGate i).complete =
      !(match firstStop i order with
        | some s => (outcome s i).isWait
        | none => false) := by
  show (!(run i order Acc.start).pending) = _
  rw [(run_spec i order Acc.start rfl).2]

theorem verdict_deny_iff (i : GateInput) :
    (evaluateGate i).verdict = .deny ↔ ∃ s, (evaluateGate i).deniedBy = some s := by
  show (if (run i order Acc.start).deniedBy.isSome then Verdict.deny else Verdict.allow) = .deny ↔
    ∃ s, (run i order Acc.start).deniedBy = some s
  cases (run i order Acc.start).deniedBy <;> simp

theorem verdict_allow_iff (i : GateInput) :
    (evaluateGate i).verdict = .allow ↔ (evaluateGate i).deniedBy = none := by
  show (if (run i order Acc.start).deniedBy.isSome then Verdict.deny else Verdict.allow) = .allow ↔
    (run i order Acc.start).deniedBy = none
  cases (run i order Acc.start).deniedBy <;> simp

theorem firstStop_none (i : GateInput) :
    firstStop i order = none ↔ ∀ s, (outcome s i).clears = true := by
  rw [forall_step]
  cases h0 : (outcome .kill i).clears <;> cases h1 : (outcome .suspend i).clears <;>
    cases h2 : (outcome .scope i).clears <;> cases h3 : (outcome .endpoint i).clears <;>
    cases h4 : (outcome .policy i).clears <;> cases h5 : (outcome .budget i).clears <;>
    simp [firstStop, order, *]

theorem firstStop_some (i : GateInput) (s : Step) :
    firstStop i order = some s ↔
      (outcome s i).clears = false ∧ ∀ t, t.rank < s.rank → (outcome t i).clears = true := by
  rw [forall_step]
  cases h0 : (outcome .kill i).clears <;> cases h1 : (outcome .suspend i).clears <;>
    cases h2 : (outcome .scope i).clears <;> cases h3 : (outcome .endpoint i).clears <;>
    cases h4 : (outcome .policy i).clears <;> cases h5 : (outcome .budget i).clears <;>
    cases s <;> simp [firstStop, order, Step.rank, *]

/-! ## 1. Allowed only if every step passes -/

/-- The gate admits a call exactly when every one of the six steps clears. -/
theorem admits_iff_all_clear (i : GateInput) :
    admits i ↔ ∀ s, (outcome s i).clears = true := by
  unfold admits
  rw [verdict_allow_iff, gate_deniedBy, gate_complete, ← firstStop_none]
  cases hfs : firstStop i order with
  | none => simp
  | some u =>
    have hu := ((firstStop_some i u).mp hfs).1
    rcases not_clears _ hu with hf | hw
    · simp [hf]
    · simp [hw]

theorem clears_iff (o : Outcome) : o.clears = true ↔ o = .pass ∨ o = .exempt := by
  cases o <;> simp [Outcome.clears]

/-- Only one step can be skipped without stopping the chain: scope, on a model
    listing, which the endpoint step governs instead. -/
theorem exempt_only_scope_listing (i : GateInput) (s : Step) (h : outcome s i = .exempt) :
    s = .scope ∧ i.modelListing = true := by
  cases s <;> simp only [outcome] at h
  case kill => unfold killOutcome at h; (repeat' (split at h)); all_goals contradiction
  case suspend => unfold suspendOutcome at h; (repeat' (split at h)); all_goals contradiction
  case endpoint => unfold endpointOutcome at h; (repeat' (split at h)); all_goals contradiction
  case policy => unfold policyOutcome at h; (repeat' (split at h)); all_goals contradiction
  case budget => unfold budgetOutcome at h; (repeat' (split at h)); all_goals contradiction
  case scope =>
    unfold scopeOutcome at h
    (repeat' (split at h)); all_goals first | contradiction | simp_all

/-- "Clears" means the step passed, with that one exception. -/
theorem clears_is_pass_or_listing (i : GateInput) (s : Step) (h : (outcome s i).clears = true) :
    outcome s i = .pass ∨ (s = .scope ∧ i.modelListing = true) := by
  rcases (clears_iff _).mp h with hp | he
  · exact Or.inl hp
  · exact Or.inr (exempt_only_scope_listing i s he)

/-- If any step fails, the gate does not admit the call. -/
theorem any_fail_refuses (i : GateInput) (s : Step) (r : Rule) (h : outcome s i = .fail r) :
    ¬ admits i := by
  intro ha
  have := (admits_iff_all_clear i).mp ha s
  simp [h, Outcome.clears] at this

/-- An admitted call had every input supplied: the kill state was read, the
    agent is not suspended, the scope and the policy were supplied, and the
    budget reserve said yes. -/
theorem admitted_has_every_input (i : GateInput) (ha : admits i) :
    i.killState.isSome = true ∧ i.suspended = some false ∧ i.scopes.isSome = true ∧
      i.policy.isSome = true ∧ i.budget = some true := by
  have h := (admits_iff_all_clear i).mp ha
  have hk := h .kill
  have hs := h .suspend
  have hsc := h .scope
  have hp := h .policy
  have hb := h .budget
  simp only [outcome] at hk hs hsc hp hb
  refine ⟨?_, ?_, ?_, ?_, ?_⟩
  · cases hx : i.killState <;> simp_all [killOutcome, Outcome.clears]
  · unfold suspendOutcome at hs
    (repeat' (split at hs)); all_goals simp_all [Outcome.clears]
  · cases hx : i.scopes <;> simp_all [scopeOutcome, Outcome.clears]
  · cases hx : i.policy <;> simp_all [policyOutcome, Outcome.clears]
  · unfold budgetOutcome at hb
    (repeat' (split at hb)); all_goals simp_all [Outcome.clears]

/-- If any step is still waiting for an input, the gate does not admit the call. -/
theorem any_wait_refuses (i : GateInput) (s : Step) (h : outcome s i = .wait) : ¬ admits i := by
  intro ha
  have := (admits_iff_all_clear i).mp ha s
  simp [h, Outcome.clears] at this

/-- The verdict is "deny" exactly when some step is named in `deniedBy`. -/
theorem deny_iff_denied_by (i : GateInput) :
    (evaluateGate i).verdict = .deny ↔ ∃ s, (evaluateGate i).deniedBy = some s :=
  verdict_deny_iff i

/-- A caveat the code states and callers must respect: "allow" alone is not an
    admission. With the kill state not yet read, a suspended agent gets the
    verdict "allow" on an incomplete evaluation. -/
theorem allow_alone_is_not_admission :
    ∃ i : GateInput, (evaluateGate i).verdict = .allow ∧ i.suspended = some true ∧ ¬ admits i :=
  ⟨{ agentId := "a", killState := none, suspended := some true, scopes := none,
     modelListing := false,
     endpoint := ⟨true, false, false, false, false, false⟩,
     policy := none, policyFailClosed := false, now := true, policyRateLimit := none,
     budget := none },
   by decide, rfl, by
    intro h
    exact absurd h.2 (by decide)⟩

/-! ## 2. Order -/

/-- `deniedBy` names a step exactly when that step fails and every step before
    it, in the order kill, suspend, scope, endpoint, policy, budget, cleared. -/
theorem denied_by_is_first_failure (i : GateInput) (s : Step) :
    (evaluateGate i).deniedBy = some s ↔
      (∃ r, outcome s i = .fail r) ∧ ∀ t, t.rank < s.rank → (outcome t i).clears = true := by
  rw [gate_deniedBy, ← isFail_iff]
  cases hfs : firstStop i order with
  | none =>
    have hall := (firstStop_none i).mp hfs
    constructor
    · intro h; simp at h
    · intro ⟨hf, _⟩
      have := fail_not_clears _ hf
      simp [hall s] at this
  | some u =>
    have hu := (firstStop_some i u).mp hfs
    constructor
    · intro h
      by_cases hf : (outcome u i).isFail = true
      · simp [hf] at h
        subst h
        exact ⟨hf, hu.2⟩
      · simp [hf] at h
    · intro ⟨hf, hbefore⟩
      have hs : firstStop i order = some s := (firstStop_some i s).mpr ⟨fail_not_clears _ hf, hbefore⟩
      rw [hfs] at hs
      cases hs
      simp [hf]

/-- A failing step is named even when later steps would also fail: nothing after
    the first failure is consulted. -/
theorem later_steps_cannot_rename (i : GateInput) (s t : Step)
    (hs : (evaluateGate i).deniedBy = some s) (ht : (evaluateGate i).deniedBy = some t) : s = t := by
  rw [hs] at ht
  cases ht
  rfl

theorem run_names (i : GateInput) (l : List Step) (a : Acc) :
    (run i l a).steps.map (·.name) = a.steps.map (·.name) ++ l := by
  induction l generalizing a with
  | nil => simp [run]
  | cons s rest ih =>
    rw [run, ih]
    unfold Acc.apply
    split
    · simp
    · split <;> simp

/-- The route calls the gate more than once, each time with more inputs
    (route.ts:1194, 1379, 2447). Two calls that agree on a step and on every
    step before it agree on whether that step is the one that denies. So an
    early check and the final gate can never name different steps. -/
theorem staged_gates_agree (i j : GateInput) (s : Step)
    (hsame : ∀ t, t.rank ≤ s.rank → outcome t i = outcome t j) :
    (evaluateGate i).deniedBy = some s ↔ (evaluateGate j).deniedBy = some s := by
  rw [denied_by_is_first_failure, denied_by_is_first_failure, hsame s (Nat.le_refl _)]
  constructor
  · intro ⟨hf, hb⟩
    exact ⟨hf, fun t ht => by rw [← hsame t (Nat.le_of_lt ht)]; exact hb t ht⟩
  · intro ⟨hf, hb⟩
    exact ⟨hf, fun t ht => by rw [hsame t (Nat.le_of_lt ht)]; exact hb t ht⟩

/-- Every evaluation records all six steps, once each, in order. -/
theorem steps_are_the_six_in_order (i : GateInput) :
    (evaluateGate i).steps.map (·.name) = order := by
  show (run i order Acc.start).steps.map (·.name) = order
  rw [run_names]
  rfl

/-! ## 3. Layered revocation -/

/-- The gate's kill step and `isBlocked` are the same test. -/
theorem kill_step_is_isBlocked (i : GateInput) (st : KillState) (h : i.killState = some st) :
    (∃ r, outcome .kill i = .fail r) ↔ isBlocked st i.agentId = true := by
  simp only [outcome, killOutcome, h, isBlocked]
  cases st.platformKill <;> cases st.userKill <;> cases st.denylist.contains i.agentId <;> simp

/-- Blocked by any kill control: denied, and the kill step is the one named. -/
theorem blocked_is_denied_by_kill (i : GateInput) (st : KillState) (h : i.killState = some st)
    (hb : isBlocked st i.agentId = true) :
    (evaluateGate i).verdict = .deny ∧ (evaluateGate i).deniedBy = some .kill := by
  have hd : (evaluateGate i).deniedBy = some .kill :=
    (denied_by_is_first_failure i .kill).mpr
      ⟨(kill_step_is_isBlocked i st h).mpr hb, by intro t ht; cases t <;> simp [Step.rank] at ht⟩
  exact ⟨(verdict_deny_iff i).mpr ⟨_, hd⟩, hd⟩

/-- The platform kill switch alone denies, whatever every other input is. -/
theorem platform_kill_denies (i : GateInput) (st : KillState) (h : i.killState = some st)
    (hk : st.platformKill = true) :
    (evaluateGate i).verdict = .deny ∧ (evaluateGate i).deniedBy = some .kill :=
  blocked_is_denied_by_kill i st h (by simp [isBlocked, hk])

/-- The tenant kill switch alone denies, whatever every other input is. -/
theorem tenant_kill_denies (i : GateInput) (st : KillState) (h : i.killState = some st)
    (hk : st.userKill = true) :
    (evaluateGate i).verdict = .deny ∧ (evaluateGate i).deniedBy = some .kill :=
  blocked_is_denied_by_kill i st h (by simp [isBlocked, hk])

/-- The denylist alone denies the listed agent, whatever every other input is. -/
theorem denylist_denies (i : GateInput) (st : KillState) (h : i.killState = some st)
    (hk : st.denylist.contains i.agentId = true) :
    (evaluateGate i).verdict = .deny ∧ (evaluateGate i).deniedBy = some .kill :=
  blocked_is_denied_by_kill i st h (by simp only [isBlocked, hk, Bool.or_true])

/-- Suspension alone denies, whatever every later input is. The step named is
    kill when a kill control is also armed, and suspend otherwise. -/
theorem suspension_denies (i : GateInput) (st : KillState) (h : i.killState = some st)
    (hs : i.suspended = some true) :
    (evaluateGate i).verdict = .deny ∧
      (evaluateGate i).deniedBy = some (if isBlocked st i.agentId then .kill else .suspend) := by
  by_cases hb : isBlocked st i.agentId = true
  · simpa [hb] using blocked_is_denied_by_kill i st h hb
  · have hkill : (outcome .kill i).clears = true := by
      simp only [isBlocked] at hb
      simp only [outcome, killOutcome, h]
      cases hp : st.platformKill <;> cases hu : st.userKill <;>
        cases hd : st.denylist.contains i.agentId <;> simp_all [Outcome.clears]
    have hd : (evaluateGate i).deniedBy = some .suspend :=
      (denied_by_is_first_failure i .suspend).mpr
        ⟨⟨.suspendActive, by simp [outcome, suspendOutcome, hs]⟩, by
          intro t ht
          cases t <;> simp [Step.rank] at ht
          exact hkill⟩
    exact ⟨(verdict_deny_iff i).mpr ⟨_, hd⟩, by simpa [hb] using hd⟩

/-- A recorded session stop never weakens the suspension read. -/
theorem recorded_stop_never_weakens (read : SuspendRead) (st : KillState) (agentId : String)
    (sessionId : Option String) (h : read ≠ .no) :
    withRecordedSessionStop read st agentId sessionId = read := by
  cases read <;> simp_all [withRecordedSessionStop]

/-- Each source of suspension is enough on its own for the route's `suspended`
    input to be true: the agent-level flag, the session stop read from Redis, a
    session stop just reloaded from the record, and the credential's own state. -/
theorem every_suspension_source_counts (read : SuspendRead) (st : KillState) (agentId : String)
    (sessionId : Option String) (principalSuspended : Bool)
    (h : read = .agent ∨ read = .session ∨ principalSuspended = true ∨
      (∃ sid, sessionId = some sid ∧ sid ≠ "" ∧ (agentId, sid) ∈ st.recordedSessionStops)) :
    routeSuspended read st agentId sessionId principalSuspended = true := by
  unfold routeSuspended
  rcases h with h | h | h | ⟨sid, hsid, hne, hmem⟩
  · subst h; simp [withRecordedSessionStop]
  · subst h; simp [withRecordedSessionStop]
  · simp [h]
  · cases read
    case no =>
      have hany : st.recordedSessionStops.any (fun stop => stop.1 == agentId && stop.2 == sid) = true := by
        rw [List.any_eq_true]
        exact ⟨(agentId, sid), hmem, by simp⟩
      simp [withRecordedSessionStop, hsid, hne, hany]
    case agent => simp [withRecordedSessionStop]
    case session => simp [withRecordedSessionStop]

/-- And nothing else does: with no source of suspension, the input is false. -/
theorem no_suspension_source_is_clear (st : KillState) (agentId : String)
    (sessionId : Option String)
    (h : ∀ sid, sessionId = some sid → (agentId, sid) ∉ st.recordedSessionStops) :
    routeSuspended .no st agentId sessionId false = false := by
  unfold routeSuspended
  cases sessionId with
  | none => simp [withRecordedSessionStop]
  | some sid =>
    have hno : st.recordedSessionStops.any (fun stop => stop.1 == agentId && stop.2 == sid) = false := by
      rw [Bool.eq_false_iff]
      intro hany
      rw [List.any_eq_true] at hany
      obtain ⟨⟨a, b⟩, hmem, hab⟩ := hany
      simp at hab
      obtain ⟨rfl, rfl⟩ := hab
      exact h _ rfl hmem
    by_cases hne : sid = "" <;> simp [withRecordedSessionStop, hne, hno]

/-- A call the gate admits is neither blocked nor suspended: the final gate
    re-checks revocation, it does not rely on the earlier check. -/
theorem admitted_is_not_revoked (i : GateInput) (st : KillState) (hk : i.killState = some st)
    (ha : admits i) : isBlocked st i.agentId = false ∧ i.suspended = some false := by
  refine ⟨?_, (admitted_has_every_input i ha).2.1⟩
  cases hb : isBlocked st i.agentId
  · rfl
  · obtain ⟨r, hr⟩ := (kill_step_is_isBlocked i st hk).mpr hb
    exact absurd ha (any_fail_refuses i .kill r hr)

/-- The route's first check (route.ts:1194-1217) refuses when the gate's
    `deniedBy` is kill or suspend. That check refuses exactly the blocked and the
    suspended, whatever the gate's other inputs are, supplied or not. -/
theorem revocation_gate_refuses_exactly (i : GateInput) (st : KillState) (suspended : Bool)
    (hk : i.killState = some st) (hs : i.suspended = some suspended) :
    ((evaluateGate i).deniedBy = some .kill ∨ (evaluateGate i).deniedBy = some .suspend) ↔
      (isBlocked st i.agentId = true ∨ suspended = true) := by
  constructor
  · rintro (h | h)
    · exact Or.inl ((kill_step_is_isBlocked i st hk).mp ((denied_by_is_first_failure i .kill).mp h).1)
    · obtain ⟨⟨r, hr⟩, _⟩ := (denied_by_is_first_failure i .suspend).mp h
      cases suspended
      · simp [outcome, suspendOutcome, hs] at hr
      · exact Or.inr rfl
  · rintro (h | h)
    · exact Or.inl (blocked_is_denied_by_kill i st hk h).2
    · subst h
      have := (suspension_denies i st hk hs).2
      by_cases hb : isBlocked st i.agentId = true
      · exact Or.inl (by simpa [hb] using this)
      · exact Or.inr (by simpa [hb] using this)

/-! ## 4. Failure posture -/


/-- DEFAULT, kill read fails: the state returned is "nothing armed". Fail OPEN. -/
theorem kill_read_failure_open (env : Env) (h : env.killClosed = false) (agentId : String) :
    readKillState env .redisFailed = { platformKill := false, userKill := false, denylist := [] } ∧
      isBlocked (readKillState env .redisFailed) agentId = false := by
  simp [readKillState, h, isBlocked]

/-- DEFAULT, kill read fails: a call that clears every other step is ADMITTED.
    This is the fail-open side of the asymmetry, stated as a positive fact, so
    that changing the default to fail-closed breaks this theorem. -/
theorem kill_read_failure_open_admits (env : Env) (h : env.killClosed = false) (i : GateInput)
    (hk : i.killState = some (readKillState env .redisFailed))
    (hrest : ∀ s, s ≠ .kill → (outcome s i).clears = true) : admits i := by
  rw [admits_iff_all_clear]
  intro s
  by_cases hs : s = .kill
  · subst hs
    simp [outcome, killOutcome, hk, readKillState, h, Outcome.clears]
  · exact hrest s hs

/-- FAIL-CLOSED, kill read fails: every call is denied at the kill step,
    whatever the agent and whatever every other input is. -/
theorem kill_read_failure_closed_denies (env : Env) (h : env.killClosed = true) (i : GateInput)
    (hk : i.killState = some (readKillState env .redisFailed)) :
    (evaluateGate i).verdict = .deny ∧ (evaluateGate i).deniedBy = some .kill :=
  platform_kill_denies i _ hk (by simp [readKillState, h])

/-- The same pair for the second way the read can fail: Redis answered, but the
    tenant's recorded stops could not be read. Closed: denied. -/
theorem record_read_failure_closed_denies (env : Env) (h : env.killClosed = true) (r : RedisKill)
    (i : GateInput) (hk : i.killState = some (readKillState env (.recordFailed r))) :
    (evaluateGate i).verdict = .deny ∧ (evaluateGate i).deniedBy = some .kill :=
  platform_kill_denies i _ hk (by simp [readKillState, h])

/-- Open: the state is what Redis held, no more and no less. -/
theorem record_read_failure_open (env : Env) (h : env.killClosed = false) (r : RedisKill) :
    readKillState env (.recordFailed r) = r.state := by
  simp [readKillState, h]

/-- Under either posture, a failed record read never clears a stop Redis held. -/
theorem record_read_failure_keeps_redis_stops (env : Env) (r : RedisKill) (agentId : String)
    (h : isBlocked r.state agentId = true) :
    isBlocked (readKillState env (.recordFailed r)) agentId = true := by
  cases hc : env.killClosed <;> simp_all [readKillState, isBlocked, RedisKill.state]

/-- A successful read is passed on unchanged, and a reload can only ADD a tenant
    stop: posture plays no part when nothing failed. -/
theorem successful_read_ignores_posture (env env' : Env) (r : RedisKill) (tenantStop : Bool)
    (sessions : List (String × String)) (agentId : String) :
    readKillState env (.loaded r) = readKillState env' (.loaded r) ∧
      readKillState env (.reloaded r tenantStop sessions) =
        readKillState env' (.reloaded r tenantStop sessions) ∧
      (isBlocked r.state agentId = true →
        isBlocked (readKillState env (.reloaded r tenantStop sessions)) agentId = true) := by
  refine ⟨rfl, rfl, ?_⟩
  simp only [readKillState, isBlocked, RedisKill.state]
  cases r.platform <;> cases r.tenant <;> cases tenantStop <;> simp

/-- DEFAULT, policy unreadable: the policy step passes. Fail OPEN. -/
theorem policy_unreadable_open (i : GateInput) (hp : i.policy = some .unreadable)
    (hc : i.policyFailClosed = false) : outcome .policy i = .pass := by
  simp [outcome, policyOutcome, hp, hc]

/-- DEFAULT, policy unreadable: a call that clears every other step is ADMITTED. -/
theorem policy_unreadable_open_admits (i : GateInput) (hp : i.policy = some .unreadable)
    (hc : i.policyFailClosed = false)
    (hrest : ∀ s, s ≠ .policy → (outcome s i).clears = true) : admits i := by
  rw [admits_iff_all_clear]
  intro s
  by_cases hs : s = .policy
  · subst hs
    simp [policy_unreadable_open i hp hc, Outcome.clears]
  · exact hrest s hs

/-- FAIL-CLOSED, policy unreadable: the policy step fails, so the call is never
    admitted; and it is denied AT the policy step when the steps before it cleared. -/
theorem policy_unreadable_closed_refuses (i : GateInput) (hp : i.policy = some .unreadable)
    (hc : i.policyFailClosed = true) :
    outcome .policy i = .fail .policyUnreadable ∧ ¬ admits i ∧
      ((∀ t, t.rank < Step.policy.rank → (outcome t i).clears = true) →
        (evaluateGate i).deniedBy = some .policy) := by
  have hf : outcome .policy i = .fail .policyUnreadable := by
    simp [outcome, policyOutcome, hp, hc]
  exact ⟨hf, any_fail_refuses i .policy _ hf,
    fun hbefore => (denied_by_is_first_failure i .policy).mpr ⟨⟨_, hf⟩, hbefore⟩⟩


end Stops
