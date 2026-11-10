import Budget.Model
/-
  PassControl budget ledger: the theorems. No `sorry`, no `axiom`.
  The headline results are at the bottom, under "HEADLINE THEOREMS".
-/
namespace Budget

/-! ## The hold map -/

theorem get_put (hs : Holds) (a b : AttemptId) (h' : Hold) :
    get (put hs a h') b = if b = a then (get hs a).map (fun _ => h') else get hs b := by
  induction hs with
  | nil => simp [get, put]
  | cons p r ih =>
    obtain ⟨c, h⟩ := p
    by_cases hca : c = a <;> by_cases hba : b = a <;> by_cases hcb : c = b <;>
      simp_all [get, put] <;> omega

theorem get_put_self {hs : Holds} {a : AttemptId} {h h' : Hold} (hg : get hs a = some h) :
    get (put hs a h') a = some h' := by
  simp [get_put, hg]

theorem get_put_ne {hs : Holds} {a b : AttemptId} {h' : Hold} (hne : b ≠ a) :
    get (put hs a h') b = get hs b := by
  simp [get_put, hne]

theorem get_del_ne {hs : Holds} {a b : AttemptId} (hne : b ≠ a) :
    get (del hs a) b = get hs b := by
  induction hs with
  | nil => simp [get, del]
  | cons p r ih =>
    obtain ⟨c, h⟩ := p
    by_cases hca : c = a <;> by_cases hcb : c = b <;> simp_all [get, del] <;> omega

/-- Keys are distinct. -/
def WF : Holds → Prop
  | [] => True
  | (b, _) :: r => get r b = none ∧ WF r

theorem wf_put {hs : Holds} (a : AttemptId) (h' : Hold) (hw : WF hs) : WF (put hs a h') := by
  induction hs with
  | nil => simp [put, WF]
  | cons p r ih =>
    obtain ⟨c, h⟩ := p
    obtain ⟨h1, h2⟩ := hw
    by_cases hca : c = a
    · simp [put, hca, WF]; subst hca; exact ⟨h1, h2⟩
    · simp [put, hca, WF]; exact ⟨by rw [get_put_ne hca]; exact h1, ih h2⟩

theorem wf_del {hs : Holds} (a : AttemptId) (hw : WF hs) : WF (del hs a) := by
  induction hs with
  | nil => simp [del, WF]
  | cons p r ih =>
    obtain ⟨c, h⟩ := p
    obtain ⟨h1, h2⟩ := hw
    by_cases hca : c = a
    · simp [del, hca]; exact h2
    · simp [del, hca, WF]; exact ⟨by rw [get_del_ne hca]; exact h1, ih h2⟩

theorem get_del_self {hs : Holds} (a : AttemptId) (hw : WF hs) : get (del hs a) a = none := by
  induction hs with
  | nil => simp [del, get]
  | cons p r ih =>
    obtain ⟨c, h⟩ := p
    obtain ⟨h1, h2⟩ := hw
    by_cases hca : c = a
    · simp [del, hca]; subst hca; exact h1
    · simp [del, hca, get]; exact ih h2

theorem sumT_put {hs : Holds} {a : AttemptId} {h h' : Hold} (hg : get hs a = some h) :
    sumT (put hs a h') + heldT h = sumT hs + heldT h' := by
  induction hs with
  | nil => simp [get] at hg
  | cons p r ih =>
    obtain ⟨c, k⟩ := p
    by_cases hca : c = a
    · simp [get, hca] at hg; subst hg; simp [put, hca, sumT]; omega
    · simp [get, hca] at hg; have := ih hg; simp [put, hca, sumT]; omega

theorem sumC_put {hs : Holds} {a : AttemptId} {h h' : Hold} (hg : get hs a = some h) :
    sumC (put hs a h') + heldC h = sumC hs + heldC h' := by
  induction hs with
  | nil => simp [get] at hg
  | cons p r ih =>
    obtain ⟨c, k⟩ := p
    by_cases hca : c = a
    · simp [get, hca] at hg; subst hg; simp [put, hca, sumC]; omega
    · simp [get, hca] at hg; have := ih hg; simp [put, hca, sumC]; omega

theorem sumT_del {hs : Holds} {a : AttemptId} {h : Hold} (hg : get hs a = some h) :
    sumT (del hs a) + heldT h = sumT hs := by
  induction hs with
  | nil => simp [get] at hg
  | cons p r ih =>
    obtain ⟨c, k⟩ := p
    by_cases hca : c = a
    · simp [get, hca] at hg; subst hg; simp [del, hca, sumT]; omega
    · simp [get, hca] at hg; have := ih hg; simp [del, hca, sumT]; omega

theorem sumC_del {hs : Holds} {a : AttemptId} {h : Hold} (hg : get hs a = some h) :
    sumC (del hs a) + heldC h = sumC hs := by
  induction hs with
  | nil => simp [get] at hg
  | cons p r ih =>
    obtain ⟨c, k⟩ := p
    by_cases hca : c = a
    · simp [get, hca] at hg; subst hg; simp [del, hca, sumC]; omega
    · simp [get, hca] at hg; have := ih hg; simp [del, hca, sumC]; omega

/-! ## Facts about single steps -/

theorem closeSt_ne_opn (o : Outcome) : closeSt o ≠ .opn := by
  cases o <;> simp [closeSt]

theorem settleable_some {s : State} {a : AttemptId} {o : Outcome} {h : Hold}
    (hs : settleable s a o = some h) : get s.holds a = some h ∧ h.st = .opn := by
  unfold settleable at hs
  split at hs
  · simp at hs
  · split at hs
    · simp at hs; subst hs; simp_all
    · simp at hs

theorem settleable_closed {s : State} {a : AttemptId} {h : Hold} (o : Outcome)
    (hg : get s.holds a = some h) (hc : h.st ≠ .opn) : settleable s a o = none := by
  simp [settleable, hg, hc]

theorem run_cons (s : State) (x : Step) (xs : List Step) :
    run s (x :: xs) = run (step s x) xs := rfl

theorem run_append (s : State) (xs ys : List Step) :
    run s (xs ++ ys) = run (run s xs) ys := by
  simp [run, List.foldl_append]

/-! ## Well-formedness and conservation are invariants -/

/-- `reserved` is exactly the open holds' stored estimates, on both counters. -/
def Conserved (s : State) : Prop :=
  s.reserved = (sumT s.holds : Int) ∧ s.reservedCost = (sumC s.holds : Int)

theorem wf_step (s : State) (x : Step) (hw : WF s.holds) : WF (step s x).holds := by
  cases x with
  | openHold a tc cc et ec =>
    simp only [step]
    split
    · exact hw
    · split
      · exact hw
      · split
        · exact hw
        · exact ⟨by assumption, hw⟩
  | settle a o kt kc =>
    simp only [step]
    split
    · exact hw
    · exact wf_put _ _ hw
  | dispatch a =>
    simp only [step]
    split
    · exact hw
    · split
      · exact wf_put _ _ hw
      · exact hw
  | raise ft fc => exact hw
  | expire a =>
    simp only [step]
    split
    · exact hw
    · split
      · exact hw
      · exact wf_del _ hw

theorem conserved_step (s : State) (x : Step) (hi : Conserved s) : Conserved (step s x) := by
  obtain ⟨ht, hc⟩ := hi
  cases x with
  | openHold a tc cc et ec =>
    simp only [step]
    split
    · exact ⟨ht, hc⟩
    · split
      · exact ⟨ht, hc⟩
      · split
        · exact ⟨ht, hc⟩
        · constructor <;> simp [sumT, sumC, heldT, heldC] <;> omega
  | settle a o kt kc =>
    simp only [step]
    split
    · exact ⟨ht, hc⟩
    · next h hs =>
      obtain ⟨hg, ho⟩ := settleable_some hs
      have h1 := sumT_put (h' := h.close o kt kc) hg
      have h2 := sumC_put (h' := h.close o kt kc) hg
      have hn := closeSt_ne_opn o
      have e1 : heldT (h.close o kt kc) = 0 := by simp [heldT, Hold.close, hn]
      have e2 : heldC (h.close o kt kc) = 0 := by simp [heldC, Hold.close, hn]
      rw [e1] at h1; rw [e2] at h2
      simp [heldT, heldC, ho] at h1 h2
      constructor <;> simp <;> omega
  | dispatch a =>
    simp only [step]
    split
    · exact ⟨ht, hc⟩
    · next h hg =>
      split
      · have h1 := sumT_put (h' := { h with ph := .dispatched }) hg
        have h2 := sumC_put (h' := { h with ph := .dispatched }) hg
        simp [heldT, heldC] at h1 h2
        constructor <;> simp <;> omega
      · exact ⟨ht, hc⟩
  | raise ft fc => exact ⟨ht, hc⟩
  | expire a =>
    simp only [step]
    split
    · exact ⟨ht, hc⟩
    · next h hg =>
      split
      · exact ⟨ht, hc⟩
      · next hn =>
        have h1 := sumT_del hg
        have h2 := sumC_del hg
        simp [heldT, heldC, hn] at h1 h2
        constructor <;> simp <;> omega

theorem wf_run (s : State) (xs : List Step) (hw : WF s.holds) : WF (run s xs).holds := by
  induction xs generalizing s with
  | nil => exact hw
  | cons x xs ih => exact ih _ (wf_step s x hw)

theorem conserved_run (s : State) (xs : List Step) (hi : Conserved s) : Conserved (run s xs) := by
  induction xs generalizing s with
  | nil => exact hi
  | cons x xs ih => exact ih _ (conserved_step s x hi)

/-! ## Replays -/

theorem open_replay {s : State} {a : AttemptId} (tc cc : Option Nat) (et ec : Nat)
    (h : (get s.holds a).isSome) : step s (.openHold a tc cc et ec) = s := by
  simp only [step]
  split
  · rfl
  · simp_all

theorem settle_replay {s : State} {a : AttemptId} {h : Hold} (o : Outcome) (kt kc : Nat)
    (hg : get s.holds a = some h) (hc : h.st ≠ .opn) : step s (.settle a o kt kc) = s := by
  simp [step, settleable_closed o hg hc]

theorem step_idem (s : State) (x : Step) (hw : WF s.holds) : step (step s x) x = step s x := by
  cases x with
  | openHold a tc cc et ec =>
    have : step s (.openHold a tc cc et ec) = s ∨
        (get (step s (.openHold a tc cc et ec)).holds a).isSome := by
      simp only [step]
      split
      · left; rfl
      · split
        · left; rfl
        · split
          · left; rfl
          · right; simp [get]
    cases this with
    | inl h => rw [h, h]
    | inr h => exact open_replay tc cc et ec h
  | settle a o kt kc =>
    have : step s (.settle a o kt kc) = s ∨
        ∃ h', get (step s (.settle a o kt kc)).holds a = some h' ∧ h'.st ≠ .opn := by
      simp only [step]
      split
      · left; rfl
      · next h hs =>
        right
        exact ⟨_, get_put_self (settleable_some hs).1, closeSt_ne_opn o⟩
    cases this with
    | inl h => rw [h, h]
    | inr h => obtain ⟨h', hg, hc⟩ := h; exact settle_replay o kt kc hg hc
  | dispatch a =>
    have : step s (.dispatch a) = s ∨
        ∃ h', get (step s (.dispatch a)).holds a = some h' ∧ h'.ph ≠ .pre := by
      simp only [step]
      split
      · left; rfl
      · next h hg =>
        split
        · right; exact ⟨_, get_put_self hg, by simp⟩
        · left; rfl
    cases this with
    | inl h => rw [h, h]
    | inr h =>
      obtain ⟨h', hg, hc⟩ := h
      generalize step s (.dispatch a) = s' at hg
      simp [step, hg, hc]
  | raise ft fc =>
    simp only [step]
    congr 1 <;> (repeat' split) <;> omega
  | expire a =>
    have : step s (.expire a) = s ∨ get (step s (.expire a)).holds a = none := by
      simp only [step]
      split
      · left; rfl
      · split
        · left; rfl
        · right; exact get_del_self a hw
    cases this with
    | inl h => rw [h, h]
    | inr h =>
      generalize step s (.expire a) = s' at h
      simp [step, h]

/-- A terminal record is frozen: nothing but its own expiry touches it. -/
theorem terminal_frozen {s : State} {a : AttemptId} {h : Hold} (x : Step)
    (hx : x ≠ .expire a) (hg : get s.holds a = some h) (hc : h.st ≠ .opn) :
    get (step s x).holds a = some h := by
  cases x with
  | openHold b tc cc et ec =>
    simp only [step]
    split
    · exact hg
    · next hb =>
      have hne : b ≠ a := by intro e; subst e; simp [hg] at hb
      split
      · exact hg
      · split
        · exact hg
        · simp [get, hne, hg]
  | settle b o kt kc =>
    simp only [step]
    split
    · exact hg
    · next k hs =>
      have hne : a ≠ b := by
        intro e; subst e
        obtain ⟨h1, h2⟩ := settleable_some hs
        rw [hg] at h1; cases h1; exact hc h2
      simp only [get_put_ne hne]; exact hg
  | dispatch b =>
    simp only [step]
    split
    · exact hg
    · next k hk =>
      split
      · next hcond =>
        have hne : a ≠ b := by
          intro e; subst e
          rw [hg] at hk; cases hk; exact hc hcond.1
        simp only [get_put_ne hne]; exact hg
      · exact hg
  | raise ft fc => exact hg
  | expire b =>
    have hne : a ≠ b := by intro e; subst e; exact hx rfl
    simp only [step]
    split
    · exact hg
    · split
      · exact hg
      · simp only [get_del_ne hne]; exact hg

/-- An open hold stays open, with the same estimates, under every step that is not
    a settle of that same attempt. -/
theorem open_stays_open {s : State} {a : AttemptId} {h : Hold} (x : Step)
    (hx : ∀ o kt kc, x ≠ .settle a o kt kc)
    (hg : get s.holds a = some h) (ho : h.st = .opn) :
    ∃ h', get (step s x).holds a = some h' ∧ h'.st = .opn ∧ h'.et = h.et ∧ h'.ec = h.ec := by
  cases x with
  | openHold b tc cc et ec =>
    simp only [step]
    split
    · exact ⟨h, hg, ho, rfl, rfl⟩
    · next hb =>
      have hne : b ≠ a := by intro e; subst e; simp [hg] at hb
      split
      · exact ⟨h, hg, ho, rfl, rfl⟩
      · split
        · exact ⟨h, hg, ho, rfl, rfl⟩
        · exact ⟨h, by simp [get, hne, hg], ho, rfl, rfl⟩
  | settle b o kt kc =>
    have hne : a ≠ b := by intro e; subst e; exact hx o kt kc rfl
    simp only [step]
    split
    · exact ⟨h, hg, ho, rfl, rfl⟩
    · exact ⟨h, by simp only [get_put_ne hne]; exact hg, ho, rfl, rfl⟩
  | dispatch b =>
    simp only [step]
    split
    · exact ⟨h, hg, ho, rfl, rfl⟩
    · next k hk =>
      split
      · by_cases e : a = b
        · subst e
          rw [hg] at hk; cases hk
          exact ⟨_, get_put_self hg, ho, rfl, rfl⟩
        · exact ⟨h, by simp only [get_put_ne e]; exact hg, ho, rfl, rfl⟩
      · exact ⟨h, hg, ho, rfl, rfl⟩
  | raise ft fc => exact ⟨h, hg, ho, rfl, rfl⟩
  | expire b =>
    simp only [step]
    split
    · exact ⟨h, hg, ho, rfl, rfl⟩
    · next k hk =>
      split
      · exact ⟨h, hg, ho, rfl, rfl⟩
      · next hn =>
        have hne : a ≠ b := by
          intro e; subst e
          rw [hg] at hk; cases hk; exact hn ho
        exact ⟨h, by simp only [get_del_ne hne]; exact hg, ho, rfl, rfl⟩

/-! ## Spend -/

theorem spent_step (s : State) (x : Step) :
    s.spent ≤ (step s x).spent ∧ s.spentCost ≤ (step s x).spentCost := by
  cases x with
  | openHold a tc cc et ec =>
    simp only [step]
    split
    · simp
    · split
      · simp
      · split <;> simp
  | settle a o kt kc =>
    simp only [step]
    split
    · simp
    · constructor <;> simp <;> omega
  | dispatch a =>
    simp only [step]
    split
    · simp
    · split <;> simp
  | raise ft fc =>
    simp only [step]
    constructor <;> split <;> omega
  | expire a =>
    simp only [step]
    split
    · simp
    · split <;> simp

/-! ## The cap -/

/-- How far one step can push `spent + reserved` (tokens) past where it was:
    a settle that charges more than the stored estimate, by the difference; a
    reconcile raise, by the amount raised. Everything else: nothing. -/
def excessT (s : State) : Step → Int
  | .settle a o kt _ =>
    match settleable s a o with
    | none => 0
    | some h => if appliedT o kt h.et > h.et then (appliedT o kt h.et : Int) - h.et else 0
  | .raise ft _ => if (ft : Int) > s.spent then ft - s.spent else 0
  | _ => 0

def excessC (s : State) : Step → Int
  | .settle a o _ kc =>
    match settleable s a o with
    | none => 0
    | some h => if appliedC o kc h.ec > h.ec then (appliedC o kc h.ec : Int) - h.ec else 0
  | .raise _ fc => if (fc : Int) > s.spentCost then fc - s.spentCost else 0
  | _ => 0

/-- The same, added up along a run. -/
def excessRunT (s : State) : List Step → Int
  | [] => 0
  | x :: xs => excessT s x + excessRunT (step s x) xs

def excessRunC (s : State) : List Step → Int
  | [] => 0
  | x :: xs => excessC s x + excessRunC (step s x) xs

/-- Every open in the step carries a token cap that is set and at most `C`. -/
def tokenCapAtMost (C : Nat) : Step → Prop
  | .openHold _ tc _ _ _ => ∃ c, tc = some c ∧ c ≤ C
  | _ => True

def costCapAtMost (C : Nat) : Step → Prop
  | .openHold _ _ cc _ _ => ∃ c, cc = some c ∧ c ≤ C
  | _ => True

theorem excessT_nonneg (s : State) (x : Step) : 0 ≤ excessT s x := by
  cases x <;> simp only [excessT] <;> (try split) <;> (try split) <;> omega

theorem excessC_nonneg (s : State) (x : Step) : 0 ≤ excessC s x := by
  cases x <;> simp only [excessC] <;> (try split) <;> (try split) <;> omega

theorem cap_stepT (C : Nat) (B : Int) (s : State) (x : Step) (hC : (C : Int) ≤ B)
    (hx : tokenCapAtMost C x) (hb : s.spent + s.reserved ≤ B) :
    (step s x).spent + (step s x).reserved ≤ B + excessT s x := by
  cases x with
  | openHold a tc cc et ec =>
    obtain ⟨c, rfl, hc⟩ := hx
    simp only [step, excessT]
    split
    · omega
    · split
      · omega
      · next hr =>
        split
        · omega
        · simp [capRefuses] at hr; simp; omega
  | settle a o kt kc =>
    have h0 := excessT_nonneg s (.settle a o kt kc)
    cases hs : settleable s a o with
    | none => simp [step, excessT, hs]; omega
    | some h => simp only [step, excessT, hs]; split <;> omega
  | dispatch a =>
    simp only [step, excessT]
    split
    · omega
    · split <;> simp <;> omega
  | raise ft fc =>
    simp only [step, excessT]
    split <;> omega
  | expire a =>
    simp only [step, excessT]
    split
    · omega
    · split <;> simp <;> omega

theorem cap_stepC (C : Nat) (B : Int) (s : State) (x : Step) (hC : (C : Int) ≤ B)
    (hx : costCapAtMost C x) (hb : s.spentCost + s.reservedCost ≤ B) :
    (step s x).spentCost + (step s x).reservedCost ≤ B + excessC s x := by
  cases x with
  | openHold a tc cc et ec =>
    obtain ⟨c, rfl, hc⟩ := hx
    simp only [step, excessC]
    split
    · omega
    · split
      · omega
      · split
        · omega
        · next hr => simp [capRefuses] at hr; simp; omega
  | settle a o kt kc =>
    have h0 := excessC_nonneg s (.settle a o kt kc)
    cases hs : settleable s a o with
    | none => simp [step, excessC, hs]; omega
    | some h => simp only [step, excessC, hs]; split <;> omega
  | dispatch a =>
    simp only [step, excessC]
    split
    · omega
    · split <;> simp <;> omega
  | raise ft fc =>
    simp only [step, excessC]
    split <;> omega
  | expire a =>
    simp only [step, excessC]
    split
    · omega
    · split <;> simp <;> omega

theorem cap_runT (C : Nat) (B : Int) (s : State) (xs : List Step) (hC : (C : Int) ≤ B)
    (hx : ∀ x ∈ xs, tokenCapAtMost C x) (hb : s.spent + s.reserved ≤ B) :
    (run s xs).spent + (run s xs).reserved ≤ B + excessRunT s xs := by
  induction xs generalizing s B with
  | nil => simpa [run, excessRunT] using hb
  | cons x xs ih =>
    have h1 := cap_stepT C B s x hC (hx x (by simp)) hb
    have h0 := excessT_nonneg s x
    have := ih (B + excessT s x) (step s x) (by omega) (fun y hy => hx y (by simp [hy])) h1
    rw [run_cons]; simp only [excessRunT]; omega

theorem cap_runC (C : Nat) (B : Int) (s : State) (xs : List Step) (hC : (C : Int) ≤ B)
    (hx : ∀ x ∈ xs, costCapAtMost C x) (hb : s.spentCost + s.reservedCost ≤ B) :
    (run s xs).spentCost + (run s xs).reservedCost ≤ B + excessRunC s xs := by
  induction xs generalizing s B with
  | nil => simpa [run, excessRunC] using hb
  | cons x xs ih =>
    have h1 := cap_stepC C B s x hC (hx x (by simp)) hb
    have h0 := excessC_nonneg s x
    have := ih (B + excessC s x) (step s x) (by omega) (fun y hy => hx y (by simp [hy])) h1
    rw [run_cons]; simp only [excessRunC]; omega

/-! # HEADLINE THEOREMS

Every one is about `run init xs` for an ARBITRARY list `xs`: every finite
sequence of script executions from the empty ledger, and so (by atomicity) every
interleaving of concurrent calls. -/

/-- CONSERVATION. `reserved` equals the sum of the open holds' stored estimates,
    on the token counter and on the cost counter. -/
theorem conservation (xs : List Step) :
    (run init xs).reserved = (sumT (run init xs).holds : Int) ∧
    (run init xs).reservedCost = (sumC (run init xs).holds : Int) :=
  conserved_run init xs ⟨rfl, rfl⟩

/-- CAP, AT ADMISSION. If an open creates a hold, then for each cap that is set:
    the cap is not zero, and `spent + reserved` INCLUDING the new hold is within
    it at that moment. -/
theorem cap_admission (xs : List Step) (a : AttemptId) (tc cc : Option Nat) (et ec : Nat)
    (hnew : get (run init xs).holds a = none)
    (hadm : get (step (run init xs) (.openHold a tc cc et ec)).holds a ≠ none) :
    (∀ c, tc = some c → c ≠ 0 ∧
      (step (run init xs) (.openHold a tc cc et ec)).spent +
      (step (run init xs) (.openHold a tc cc et ec)).reserved ≤ c) ∧
    (∀ c, cc = some c → c ≠ 0 ∧
      (step (run init xs) (.openHold a tc cc et ec)).spentCost +
      (step (run init xs) (.openHold a tc cc et ec)).reservedCost ≤ c) := by
  generalize run init xs = s at *
  simp only [step, hnew] at hadm ⊢
  by_cases h1 : capRefuses tc (s.reserved + et + s.spent)
  · simp [h1, hnew] at hadm
  · by_cases h2 : capRefuses cc (s.reservedCost + ec + s.spentCost)
    · simp [h1, h2, hnew] at hadm
    · simp only [h1, h2, ↓reduceIte]
      constructor
      · intro c hc; subst hc; simp [capRefuses] at h1; omega
      · intro c hc; subst hc; simp [capRefuses] at h2; omega

/-- CAP, WHAT A SETTLE DOES TO IT, EXACTLY. Closing a hold changes
    `spent + reserved` by (amount charged − stored estimate), on each counter. -/
theorem settle_exact (s : State) (a : AttemptId) (o : Outcome) (kt kc : Nat) (h : Hold)
    (hs : settleable s a o = some h) :
    let s' := step s (.settle a o kt kc)
    s'.spent + s'.reserved = s.spent + s.reserved + appliedT o kt h.et - h.et ∧
    s'.spentCost + s'.reservedCost = s.spentCost + s.reservedCost + appliedC o kc h.ec - h.ec := by
  simp only [step, hs]; constructor <;> omega

/-- CAP, OVER A WHOLE RUN (tokens). If every open carries a token cap of at most
    `C`, then `spent + reserved` never exceeds `C` plus the overshoot: the sum,
    over settles that charged more than their estimate, of the difference, plus
    whatever the reconcile raise added. -/
theorem cap_bound_tokens (C : Nat) (xs : List Step) (hx : ∀ x ∈ xs, tokenCapAtMost C x) :
    (run init xs).spent + (run init xs).reserved ≤ C + excessRunT init xs :=
  cap_runT C C init xs (Int.le_refl _) hx (by simp [init])

/-- CAP, OVER A WHOLE RUN (cost, micro-cents). Same statement. -/
theorem cap_bound_cost (C : Nat) (xs : List Step) (hx : ∀ x ∈ xs, costCapAtMost C x) :
    (run init xs).spentCost + (run init xs).reservedCost ≤ C + excessRunC init xs :=
  cap_runC C C init xs (Int.le_refl _) hx (by simp [init])

/-- IDEMPOTENCE. Replaying any step straight after itself changes nothing. -/
theorem idempotent (xs : List Step) (x : Step) :
    step (step (run init xs) x) x = step (run init xs) x :=
  step_idem _ x (wf_run init xs trivial)

/-- IDEMPOTENCE, LATER (open). Once a hold exists for an attempt, opening that
    attempt again is a no-op after ANY further steps, for any arguments, as long
    as the record has not expired in between. -/
theorem replay_open_later (s : State) (a : AttemptId) (ys : List Step)
    (tc cc : Option Nat) (et ec : Nat)
    (hrec : (get s.holds a).isSome) (hy : ∀ y ∈ ys, y ≠ .expire a) :
    step (run s ys) (.openHold a tc cc et ec) = run s ys := by
  apply open_replay
  induction ys generalizing s with
  | nil => exact hrec
  | cons y ys ih =>
    rw [run_cons]
    apply ih _ _ (fun z hz => hy z (by simp [hz]))
    have hne := hy y (by simp)
    cases hg : get s.holds a with
    | none => simp [hg] at hrec
    | some h =>
      by_cases ho : h.st = .opn
      · by_cases hset : ∃ o kt kc, y = .settle a o kt kc
        · obtain ⟨o, kt, kc, rfl⟩ := hset
          simp only [step]
          split
          · simp [hg]
          · next k hk => simp [get_put_self (settleable_some hk).1]
        · obtain ⟨h', hg', _⟩ := open_stays_open y
            (fun o kt kc e => hset ⟨o, kt, kc, e⟩) hg ho
          simp [hg']
      · simp [terminal_frozen y hne hg ho]

/-- IDEMPOTENCE, LATER (settle). Once a hold is closed, settling that attempt
    again is a no-op after ANY further steps, for any outcome and any figures, as
    long as the record has not expired in between. -/
theorem replay_settle_later (s : State) (a : AttemptId) (h : Hold) (ys : List Step)
    (o : Outcome) (kt kc : Nat)
    (hg : get s.holds a = some h) (hc : h.st ≠ .opn) (hy : ∀ y ∈ ys, y ≠ .expire a) :
    step (run s ys) (.settle a o kt kc) = run s ys := by
  have : get (run s ys).holds a = some h := by
    induction ys generalizing s with
    | nil => exact hg
    | cons y ys ih =>
      rw [run_cons]
      exact ih _ (terminal_frozen y (hy y (by simp)) hg hc) (fun z hz => hy z (by simp [hz]))
  exact settle_replay o kt kc this hc

/-- MONOTONE SPEND. Extending a run never lowers `spent`, on either counter. -/
theorem spent_monotone (xs ys : List Step) :
    (run init xs).spent ≤ (run init (xs ++ ys)).spent ∧
    (run init xs).spentCost ≤ (run init (xs ++ ys)).spentCost := by
  rw [run_append]
  generalize run init xs = s
  induction ys generalizing s with
  | nil => simp [run]
  | cons y ys ih =>
    rw [run_cons]
    have h1 := spent_step s y
    have h2 := ih (step s y)
    omega

/-- NO SILENT RELEASE. An open hold is still open, with the same stored
    estimates, after any sequence of steps that contains no settle of that
    attempt. Dispatch, other attempts, the reconcile raise and the passing of
    time (`expire`) cannot close it or change what it reserves. -/
theorem no_silent_release (s : State) (a : AttemptId) (h : Hold) (ys : List Step)
    (hg : get s.holds a = some h) (ho : h.st = .opn)
    (hy : ∀ y ∈ ys, ∀ o kt kc, y ≠ .settle a o kt kc) :
    ∃ h', get (run s ys).holds a = some h' ∧ h'.st = .opn ∧ h'.et = h.et ∧ h'.ec = h.ec := by
  induction ys generalizing s h with
  | nil => exact ⟨h, hg, ho, rfl, rfl⟩
  | cons y ys ih =>
    obtain ⟨h1, hg1, ho1, e1, e2⟩ := open_stays_open y (hy y (by simp)) hg ho
    obtain ⟨h2, hg2, ho2, e3, e4⟩ := ih (step s y) h1 hg1 ho1 (fun z hz => hy z (by simp [hz]))
    exact ⟨h2, by rw [run_cons]; exact hg2, ho2, by omega, by omega⟩

/-- ...and the only way out of `open` is to a closed state chosen by the settle's
    outcome: settled, released or resolved. -/
theorem settle_closes (s : State) (a : AttemptId) (o : Outcome) (kt kc : Nat) (h : Hold)
    (hs : settleable s a o = some h) :
    ∃ h', get (step s (.settle a o kt kc)).holds a = some h' ∧ h'.st = closeSt o ∧
      h'.appT = appliedT o kt h.et ∧ h'.appC = appliedC o kc h.ec := by
  simp only [step, hs]
  exact ⟨_, get_put_self (settleable_some hs).1, rfl, rfl, rfl⟩

end Budget
