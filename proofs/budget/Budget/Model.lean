/-
  PassControl budget ledger: the model.

  Source of truth: the Lua scripts in `lib/state/holds.ts` (OPEN_LUA, SETTLE_LUA,
  DISPATCH_LUA, RAISE_LUA). Each script is ONE atomic step function here.

  ASSUMPTION (atomicity). Redis runs a script atomically: one primary, no script
  killed half-way. So every concurrent execution is some SEQUENCE of steps, and a
  theorem over every finite sequence covers every interleaving.

  WHERE THE MODEL SIMPLIFIES THE CODE (each one is a limit on what is proved):

  S1  One agent. Its keys are the four counters and its holds.
  S2  The agent is budgeted and its counters are PRESENT with a matching epoch
      and format tag. So OPEN_LUA's state refusal (-3), SETTLE_LUA's generation
      refusal (-2, wrong epoch) and its degraded close (3) cannot happen. Key
      eviction, REBASE_LUA (operator rebuild) and the bootstrap branches are out.
  S3  No period limit (K1: `periodMode = skip`), no sub-ledger (C(b)), no
      delegation ledgers (Bet D).
  S4  Numbers are exact integers. Lua uses doubles, exact below 2^53.
  S5  The wrappers clamp estimates and reported usage to integers >= 0, so those
      are `Nat` here. A cap is `none` (Lua -1, unset) or `some c`.
  S6  A hold keeps only the fields a transition READS or a replay RETURNS:
      st, ph, et, ec, at, ac. (`cr`, `ep`, `pv`, `md`, `kt`, `kc`, `oc` are
      written and never read by a transition.) The `holds:` index is dropped: it
      is a report, never an input to a counter.
  S7  RAISE_LUA is modelled only for what it does to `spent` / `spent_cost`.
  S8  Time appears as one step, `expire`: the 900 s TTL that SETTLE_LUA puts on a
      terminal hold fires and the record disappears. No other step reads a clock.
  S9  Attempt ids are `Nat` (strings in the code); holds are an association list
      read and written at the first match.
-/
namespace Budget

abbrev AttemptId := Nat

/-- `st` on the hold. `opn` is Lua's 'open' (a Lean keyword). -/
inductive St where
  | opn | settled | released | resolved
  deriving DecidableEq, Repr

/-- `ph` on the hold: 'pre_dispatch' | 'dispatch_may_have_happened'. -/
inductive Phase where
  | pre | dispatched
  deriving DecidableEq, Repr

structure Hold where
  st : St
  ph : Phase
  /-- stored token estimate (`et`) -/
  et : Nat
  /-- stored cost estimate (`ec`) -/
  ec : Nat
  /-- applied tokens (`at`), 0 while open -/
  appT : Nat
  /-- applied cost (`ac`), 0 while open -/
  appC : Nat
  deriving DecidableEq, Repr

abbrev Holds := List (AttemptId × Hold)

def get : Holds → AttemptId → Option Hold
  | [], _ => none
  | (b, h) :: r, a => if b = a then some h else get r a

def put : Holds → AttemptId → Hold → Holds
  | [], _, _ => []
  | (b, h) :: r, a, h' => if b = a then (b, h') :: r else (b, h) :: put r a h'

def del : Holds → AttemptId → Holds
  | [], _ => []
  | (b, h) :: r, a => if b = a then r else (b, h) :: del r a

/-- What a hold contributes to `reserved`: its estimate while open, else 0. -/
def heldT (h : Hold) : Nat := if h.st = .opn then h.et else 0
def heldC (h : Hold) : Nat := if h.st = .opn then h.ec else 0

def sumT : Holds → Nat
  | [] => 0
  | (_, h) :: r => heldT h + sumT r

def sumC : Holds → Nat
  | [] => 0
  | (_, h) :: r => heldC h + sumC r

structure State where
  /-- `reserved:` -/
  reserved : Int
  /-- `spent:` -/
  spent : Int
  /-- `reserved_cost:` -/
  reservedCost : Int
  /-- `spent_cost:` -/
  spentCost : Int
  holds : Holds

def init : State := ⟨0, 0, 0, 0, []⟩

/-- SETTLE_LUA's `outcome`, with the two certainty flags of 'complete'. -/
inductive Outcome where
  | complete (tokensKnown moneyKnown : Bool)
  | usageUnknown
  | notDispatched
  | resolved
  deriving DecidableEq, Repr

/-- Lua `applied(known, estimate, certainty)`. -/
def charge (known est : Nat) (certain : Bool) : Nat :=
  if certain then known else if known > est then known else est

def appliedT (o : Outcome) (known est : Nat) : Nat :=
  match o with
  | .complete tk _ => charge known est tk
  | .usageUnknown => charge known est false
  | .notDispatched => 0
  | .resolved => known

def appliedC (o : Outcome) (known est : Nat) : Nat :=
  match o with
  | .complete _ mk => charge known est mk
  | .usageUnknown => charge known est false
  | .notDispatched => 0
  | .resolved => known

def closeSt : Outcome → St
  | .complete _ _ => .settled
  | .usageUnknown => .settled
  | .notDispatched => .released
  | .resolved => .resolved

/-- OPEN_LUA: `cap >= 0 and (cap == 0 or (reserved + estimate + spent) > cap)`. -/
def capRefuses : Option Nat → Int → Prop
  | none, _ => False
  | some c, total => c = 0 ∨ total > (c : Int)

instance (cap : Option Nat) (t : Int) : Decidable (capRefuses cap t) := by
  unfold capRefuses; split <;> infer_instance

/-- The hold a settle would close, if any: it exists, is open, and the outcome is
    not `not_dispatched` on an attempt whose dispatch permission was consumed. -/
def settleable (s : State) (a : AttemptId) (o : Outcome) : Option Hold :=
  match get s.holds a with
  | none => none
  | some h =>
    if h.st = .opn ∧ ¬(o = .notDispatched ∧ h.ph ≠ .pre) then some h else none

/-- The record SETTLE_LUA leaves behind: closed, with what was applied. -/
def Hold.close (h : Hold) (o : Outcome) (kt kc : Nat) : Hold :=
  { h with st := closeSt o, appT := appliedT o kt h.et, appC := appliedC o kc h.ec }

inductive Step where
  /-- OPEN_LUA -/
  | openHold (a : AttemptId) (tokenCap costCap : Option Nat) (et ec : Nat)
  /-- SETTLE_LUA -/
  | settle (a : AttemptId) (o : Outcome) (knownT knownC : Nat)
  /-- DISPATCH_LUA -/
  | dispatch (a : AttemptId)
  /-- RAISE_LUA (reconcile's monotone raise) -/
  | raise (floorT floorC : Nat)
  /-- the tombstone TTL firing -/
  | expire (a : AttemptId)

def step (s : State) : Step → State
  | .openHold a tc cc et ec =>
    match get s.holds a with
    | some _ => s                                             -- code 2, replay
    | none =>
      if capRefuses tc (s.reserved + et + s.spent) then s     -- code -1
      else if capRefuses cc (s.reservedCost + ec + s.spentCost) then s  -- code -2
      else
        { s with
          reserved := s.reserved + et
          reservedCost := s.reservedCost + ec
          holds := (a, ⟨.opn, .pre, et, ec, 0, 0⟩) :: s.holds }  -- code 1
  | .settle a o kt kc =>
    match settleable s a o with
    | none => s                                               -- codes -1, 0, -2
    | some h =>
      { reserved := s.reserved - h.et
        spent := s.spent + appliedT o kt h.et
        reservedCost := s.reservedCost - h.ec
        spentCost := s.spentCost + appliedC o kc h.ec
        holds := put s.holds a (h.close o kt kc) }
  | .dispatch a =>
    match get s.holds a with
    | none => s
    | some h =>
      if h.st = .opn ∧ h.ph = .pre then
        { s with holds := put s.holds a { h with ph := .dispatched } }
      else s
  | .raise ft fc =>
    { s with
      spent := if (ft : Int) > s.spent then ft else s.spent
      spentCost := if (fc : Int) > s.spentCost then fc else s.spentCost }
  | .expire a =>
    match get s.holds a with
    | none => s
    | some h => if h.st = .opn then s else { s with holds := del s.holds a }

/-- Run a sequence of steps, in order. -/
def run (s : State) (xs : List Step) : State := xs.foldl step s

end Budget
