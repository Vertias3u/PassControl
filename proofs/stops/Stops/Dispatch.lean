import Stops.Model
import Stops.Theorems

/-
  PassControl stop checks: one request as a trace in time.

  Source of truth, read on 2026-11-13 at commit 944adc4:
    lib/gateway/dispatch-stops.ts            the whole file (dispatchStopChecker,
                                             passportExpiryRefusal)
    app/api/v1/[provider]/[...path]/route.ts
        822, 1064, 1197, 1262    the admission reads and their time stamps
        1289-1292                the checker is built
        1343                     the body read
        2303-2312                the expiry check before a delegated visa's hold
        2339                     the hold
        3047-3048                re-check before the key, forced on a failover
        3424                     the dispatch permission
        3466-3471                re-check at the send, then `fetch`
        3842                     the failover qualification read (Redis, and the
                                 local expiry check)
    app/api/v1/svc/[service]/[...path]/route.ts
        664-677                  re-check before the token
        783-788                  re-check at the send, then `fetch`
    lib/state/redis.ts 653-667   isSuspended and what it returns when it throws

  `Stops/Model.lean` and `Stops/Service.lean` treat a request as one moment:
  every input is read once and the checks run in order. That cannot see a stop
  that lands AFTER it was read and BEFORE the call goes out. This file gives a
  request a length. It is a list of steps, and between any two steps the world
  may change: a stop is armed or cleared, time passes, a store becomes
  unreadable or readable again.

  WHERE THE MODEL SIMPLIFIES THE CODE (each one is a limit on what is proved):

  D1  One request. Other requests, the dashboard and the clock are the "events".
      A step is atomic: an event lands before it or after it. A read sees the
      world as it is at the instant its step runs, which stands for the instant
      the store answered.
  D2  The order of the ADMISSION reads is fixed here as: credential, expiry,
      mission, delegation, then Redis. The LLM route reads the delegation after
      Redis and the service route reads the kill switch before the mission.
      Nothing below depends on the order inside admission; the order of the
      admission checks is the subject of Model.lean and Service.lean.
  D3  When an authority read refuses, the helper still performs its Redis read
      and reports the Redis stop if both refuse. The model stops at the first
      refusal. Neither sends.
  D4  Every refusal that is not a stop is left out: rate limit, scope, policy,
      budget cap at the hold, unpriced model, injection guard, an approval that
      is denied or times out, a missing key, a dispatch permission that is
      refused or unreadable. Each of them ends the attempt without a send, so
      leaving them out removes only traces with FEWER sends.
  D5  A mission is one bit: "the mission gate would now refuse this caller"
      (ended, revoked, out of its time window, revised, or newly required). A
      Direct Agent Key is one bit: "the key no longer authenticates as the same
      active agent" (revoked, re-bound, or the agent suspended in the database).
  D6  A session stop is seen through the suspend read only. The second way the
      code can see it (the recorded stops the kill read reloads) is left out;
      `recorded_stop_never_weakens` in Theorems.lean says it only adds refusals.
  D7  The kill read has one failure here: Redis unreadable. The second failure
      (Redis answered, the tenant's record did not) is in Theorems.lean.
  D8  The hold of an attempt that was sent is settled in the step right after
      the send. In the code that follows the upstream response. Whether the
      amount is right is the subject of proofs/budget, not of this file.
  D9  The model stamps an admission read with the time of that read. The code
      stamps just before the read, so the code's stamp is the same or older.
      An older stamp only makes a re-read come sooner.
  D10 Whether a failover candidate qualifies for reasons other than a stop
      (scope, policy, the attempt cap, embeddings never fail over) is one bit
      chosen by the environment.
  D11 The slow upload and the approval wait are steps that any amount of time
      can pass before. The LLM route's injection-guard wait is the same step.
  D12 Expiry of the visa or of a delegation link is an event, not a function
      of the clock. A mission running out of its window belongs to `mission`,
      because the mission re-read does compare the clock.
  D13 What happens to an upstream call that has ALREADY been sent is not
      modelled. A stop that lands after the send does not un-send it.
  D14 The per-service stop applies on the service route only. A delegation
      applies on the LLM route only: the service route admits no delegated visa.
  D15 The demo route is not modelled. It has no upstream call.
  D17 Expiry is compared on every re-check and, for a delegated visa, once more
      just before each hold (route.ts:2311). That second comparison is modelled.
      A third one, before the hold is retried with a period seed (route.ts:2424),
      is not: the retry itself is not modelled (D4).
  D16 The model does not prove that a request finishes. It proves what is true
      at every point of every run, finished or not, and that a refused re-check
      reaches its end in two more steps.
-/

namespace Stops.Dispatch

open Stops

/-! ## Stops, the world, and what can happen to it -/

/-- Everything that can stop a call that was already admitted. -/
inductive Stop where
  | platform | tenant | denylist | service | session | suspend
  | delegation | mission | directKey
  | expiry
  deriving DecidableEq, Repr

/-- The stores a stop is read from. Each can be unreadable. -/
inductive Source where
  | kill | suspend | delegation | mission | directKey
  deriving DecidableEq, Repr

/-- Where each stop is read from. Expiry is read from the visa itself, so its
    read cannot fail. -/
def Stop.source : Stop → Option Source
  | .platform => some .kill
  | .tenant => some .kill
  | .denylist => some .kill
  | .service => some .kill
  | .session => some .suspend
  | .suspend => some .suspend
  | .delegation => some .delegation
  | .mission => some .mission
  | .directKey => some .directKey
  | .expiry => none

/-- The six stops kept in Redis and read together (dispatch-stops.ts:88-91). The
    other four are the "authority" reads (dispatch-stops.ts:43-84) and expiry. -/
def Stop.isRedis : Stop → Bool
  | .platform => true
  | .tenant => true
  | .denylist => true
  | .service => true
  | .session => true
  | .suspend => true
  | _ => false

/-- The world a request runs in. -/
structure World where
  /-- The clock, in milliseconds. -/
  now : Nat
  /-- Which stops are in force. -/
  armed : Stop → Bool
  /-- Which stores cannot be read. -/
  broken : Source → Bool

/-- One thing that happens to the world between two steps of a request. -/
inductive Event where
  | arm (s : Stop)
  | clear (s : Stop)
  | elapse (ms : Nat)
  | break (src : Source)
  | mend (src : Source)
  deriving DecidableEq, Repr

def World.apply (w : World) : Event → World
  | .arm s => { w with armed := fun x => if x = s then true else w.armed x }
  | .clear s => { w with armed := fun x => if x = s then false else w.armed x }
  | .elapse ms => { w with now := w.now + ms }
  | .break src => { w with broken := fun x => if x = src then true else w.broken x }
  | .mend src => { w with broken := fun x => if x = src then false else w.broken x }

/-- The world after a list of events, oldest first. -/
def World.after (w : World) (es : List Event) : World := es.foldl World.apply w

theorem clock_never_runs_back (w : World) (es : List Event) : w.now ≤ (w.after es).now := by
  unfold World.after
  induction es generalizing w with
  | nil => exact Nat.le_refl _
  | cons e es ih =>
    have h : w.now ≤ (w.apply e).now := by cases e <;> simp [World.apply]
    exact Nat.le_trans h (ih _)

/-! ## The request and the configuration -/

inductive Route where
  | llm | service
  deriving DecidableEq, Repr

inductive Door where
  | passport | directKey
  deriving DecidableEq, Repr

/-- What kind of request this is. -/
structure Req where
  route : Route
  door : Door
  /-- The visa carries a delegation chain. -/
  delegated : Bool
  /-- An approval wait happens before the call. -/
  asks : Bool
  /-- How many failover candidates are configured (LLM route). -/
  fallbacks : Nat
  deriving DecidableEq, Repr

/-- What the gateway is configured to do. -/
structure Cfg where
  /-- `KILL_SWITCH_FAIL_CLOSED === "true"`. -/
  killClosed : Bool
  /-- The re-check compares expiry. TRUE in the code since commit 944adc4, which
      closed gap B5-05. `false` is the code before that commit. -/
  rereadsExpiry : Bool
  /-- `DISPATCH_AUTHORITY_MAX_AGE_MS` (dispatch-stops.ts:11). -/
  maxAge : Nat
  deriving DecidableEq, Repr

/-- The code as it is at commit 944adc4. Expiry is compared on every re-check
    (dispatch-stops.ts:58), with no 2-second rule: it is a clock comparison on
    claims already verified, not a read. -/
def code (killClosed : Bool) : Cfg :=
  { killClosed := killClosed, rereadsExpiry := true, maxAge := 2000 }

/-- The code, with the posture read from the environment as the gateway reads it. -/
def codeOf (env : Env) : Cfg := code env.killClosed

/-- Which stops can apply to this request at all. -/
def applies (r : Req) : Stop → Bool
  | .service => decide (r.route = .service)
  | .delegation => decide (r.route = .llm) && decide (r.door = .passport) && r.delegated
  | .directKey => decide (r.door = .directKey)
  | .expiry => decide (r.door = .passport)
  | _ => true

/-- Does a read of stop `s`, made in world `w`, refuse the call?
    THE FAILURE POSTURE OF EACH STOP IS THIS FUNCTION AND NOTHING ELSE.
      kill switch (platform, tenant, denylist, per-service): unreadable refuses
        only when KILL_SWITCH_FAIL_CLOSED is "true" (killswitch.ts:153, 181).
      suspend and session: the same variable (redis.ts:666).
      delegation, mission, Direct Agent Key: unreadable always refuses
        (dispatch-stops.ts:53-55, 59, 79-81).
      expiry: cannot be unreadable. -/
def refusesOn (cfg : Cfg) (w : World) (s : Stop) : Bool :=
  match s.source with
  | none => w.armed s
  | some .kill => if w.broken .kill = true then cfg.killClosed else w.armed s
  | some .suspend => if w.broken .suspend = true then cfg.killClosed else w.armed s
  | some src => w.broken src || w.armed s

/-- The Redis read: `readKillState` and `isSuspended`, together. -/
def redisStops (r : Req) : List Stop :=
  if r.route = .service then [.platform, .tenant, .denylist, .service, .session, .suspend]
  else [.platform, .tenant, .denylist, .session, .suspend]

/-- The order the helper reads the authorities in (dispatch-stops.ts:45, 57, 73). -/
def authorityOrder : List Stop := [.directKey, .expiry, .mission, .delegation]

/-- Is this stop among the ones the re-check reads? -/
def rereads (cfg : Cfg) (a : Stop) : Bool := a != .expiry || cfg.rereadsExpiry

/-- Is authority `a` read by a re-check that starts at time `t0`?
    `forceAuthority || now - readAt > DISPATCH_AUTHORITY_MAX_AGE_MS`. -/
def isDue (cfg : Cfg) (r : Req) (stamp : Stop → Nat) (force : Bool) (t0 : Nat) (a : Stop) : Bool :=
  applies r a &&
    (if a = .expiry then cfg.rereadsExpiry else (force || decide (cfg.maxAge < t0 - stamp a)))

/-- The four places a stop is read. -/
inductive Phase where
  /-- When the request arrives. -/
  | admission
  /-- Before the provider key is resolved (route.ts:3032, svc 676). -/
  | beforeKey
  /-- Right before `fetch` (route.ts:3451, svc 783). -/
  | atSend
  /-- Before a failover candidate is taken up (route.ts:3842). Redis, and the
      local expiry check; no authority read. -/
  | qualify
  /-- Just before the hold of a delegated visa (route.ts:2311): the local
      expiry check alone. Only ever the phase of a refusal. -/
  | beforeHold
  deriving DecidableEq, Repr

/-- The authority reads a check makes. `n` is the attempt: 0 is the first, 1 and
    up are failovers. Before the key of a failover the reads are FORCED
    (`checkDispatchStops(!primary)`, route.ts:3032). At the send they are not
    (`checkDispatchStops()`, route.ts:3451). -/
def due (cfg : Cfg) (r : Req) (stamp : Stop → Nat) (n : Nat) (ph : Phase) (t0 : Nat) : List Stop :=
  match ph with
  | .admission => authorityOrder.filter (applies r)
  | .beforeKey => authorityOrder.filter (isDue cfg r stamp (decide (0 < n)) t0)
  | .atSend => authorityOrder.filter (isDue cfg r stamp false t0)
  | .qualify => authorityOrder.filter (fun a => decide (a = .expiry) && isDue cfg r stamp false t0 a)
  | .beforeHold => []

/-! ## Steps, and the trace -/

/-- One step of a request. -/
inductive Action where
  /-- A read of `stops`, in the check of attempt `n` that began at time `t0`. -/
  | read (n : Nat) (ph : Phase) (t0 : Nat) (stops : List Stop)
  | body
  | approval
  | hold (n : Nat)
  | key (n : Nat)
  | permit (n : Nat)
  /-- The upstream request of attempt `n` goes out. -/
  | send (n : Nat)
  /-- The hold of a sent attempt is settled. -/
  | settle (n : Nat)
  /-- The hold is released: nothing was sent (`not_dispatched`). -/
  | release (n : Nat)
  /-- The hold is settled at zero: refused after the dispatch permission. -/
  | settleZero (n : Nat)
  /-- The request is refused by a stop. -/
  | refuse (n : Nat) (ph : Phase)
  /-- A stop ended the failover loop; the earlier answer is returned. -/
  | stopFailover (n : Nat)
  | respond
  deriving DecidableEq, Repr

/-- One entry of the trace: the events that landed since the step before, the
    world they left, and the step that then ran. -/
structure Frame where
  pre : List Event
  w : World
  act : Action

/-- Where the request is. -/
inductive Pc where
  /-- A check begins at the next step. -/
  | enter (n : Nat) (ph : Phase)
  /-- Inside a check that began at `t0`: `todo` authority reads, then Redis. -/
  | check (n : Nat) (ph : Phase) (t0 : Nat) (todo : List Stop)
  | body
  | approval
  | hold (n : Nat)
  | key (n : Nat)
  | permit (n : Nat)
  | send (n : Nat)
  | settle (n : Nat) (failover : Bool)
  | closing (n : Nat) (ph : Phase)
  | refused (n : Nat) (ph : Phase)
  | stopping (n : Nat)
  | respond
  | done
  deriving DecidableEq, Repr

/-- What the environment does around one step: the events that land before it,
    and one bit for an outcome that is not a stop (the upstream answered without
    asking for a failover; the failover candidate qualifies). -/
structure Tick where
  events : List Event
  ok : Bool

structure St where
  pc : Pc
  /-- When each authority was last read and found clear. -/
  stamp : Stop → Nat
  w : World
  /-- Newest first. -/
  trace : List Frame

/-- Run one step: the tick's events land, then the step is recorded. -/
def St.push (s : St) (t : Tick) (a : Action) (pc : Pc) (stamp : Stop → Nat) : St :=
  { pc := pc, stamp := stamp, w := s.w.after t.events,
    trace := { pre := t.events, w := s.w.after t.events, act := a } :: s.trace }

/-- Where a refused read goes. On the LLM route a re-check refusal first closes
    the hold; the service route opens no hold. -/
def refusalPc (r : Req) (n : Nat) : Phase → Pc
  | .admission => .refused n .admission
  | .qualify => .stopping n
  | .beforeHold => .refused n .beforeHold
  | .beforeKey => if r.route = .llm then .closing n .beforeKey else .refused n .beforeKey
  | .atSend => if r.route = .llm then .closing n .atSend else .refused n .atSend

/-- The time a read is stamped with: its own time at admission, the start of
    its check afterwards (`const now = Date.now()`, dispatch-stops.ts:42). -/
def startOf (ph : Phase) (t0 : Nat) (w : World) : Nat :=
  match ph with
  | .admission => w.now
  | _ => t0

/-- One step inside a check. Authority reads first, one per step, then Redis. -/
def stepCheck (cfg : Cfg) (r : Req) (t : Tick) (s : St) (n : Nat) (ph : Phase) (t0 : Nat) :
    List Stop → St
  | a :: rest =>
    if refusesOn cfg (s.w.after t.events) a = true then
      s.push t (.read n ph (startOf ph t0 (s.w.after t.events)) [a]) (refusalPc r n ph) s.stamp
    else
      s.push t (.read n ph (startOf ph t0 (s.w.after t.events)) [a]) (.check n ph t0 rest)
        (fun x => if x = a then startOf ph t0 (s.w.after t.events) else s.stamp x)
  | [] =>
    if (redisStops r).any (refusesOn cfg (s.w.after t.events)) = true then
      s.push t (.read n ph (startOf ph t0 (s.w.after t.events)) (redisStops r)) (refusalPc r n ph)
        s.stamp
    else
      match ph with
      | .admission =>
        s.push t (.read n .admission (s.w.after t.events).now (redisStops r)) .body s.stamp
      | .beforeKey => s.push t (.read n .beforeKey t0 (redisStops r)) (.key n) s.stamp
      | .atSend => s.push t (.read n .atSend t0 (redisStops r)) (.send n) s.stamp
      | .qualify =>
        if t.ok = true then s.push t (.read n .qualify t0 (redisStops r)) (.hold n) s.stamp
        else s.push t (.read n .qualify t0 (redisStops r)) .respond s.stamp
      | .beforeHold => s.push t (.read n .beforeHold t0 (redisStops r)) .respond s.stamp

/-- One step of the request, by where it is. -/
def stepAt (cfg : Cfg) (r : Req) (t : Tick) (s : St) : Pc → St
  | .enter n ph =>
    stepCheck cfg r t s n ph (s.w.after t.events).now
      (due cfg r s.stamp n ph (s.w.after t.events).now)
  | .check n ph t0 todo => stepCheck cfg r t s n ph t0 todo
  | .body =>
    if r.asks = true then s.push t .body .approval s.stamp
    else if r.route = .llm then s.push t .body (.hold 0) s.stamp
    else s.push t .body (.enter 0 .beforeKey) s.stamp
  | .approval =>
    if r.route = .llm then s.push t .approval (.hold 0) s.stamp
    else s.push t .approval (.enter 0 .beforeKey) s.stamp
  | .hold n =>
    -- A delegated visa that has expired opens no hold (route.ts:2311). This is
    -- decided on the world as the step before left it, and it is not a step of
    -- its own: nothing is read and nothing waits, so the tick is not used.
    if cfg.rereadsExpiry = true ∧ r.delegated = true ∧ s.w.armed .expiry = true then
      { s with pc := .refused n .beforeHold }
    -- RE-CHECK ONE: after the hold, before the key. Every attempt.
    else s.push t (.hold n) (.enter n .beforeKey) s.stamp
  | .key n =>
    if r.route = .llm then s.push t (.key n) (.permit n) s.stamp
    -- RE-CHECK TWO on the service route: after the token, at the send.
    else s.push t (.key n) (.enter n .atSend) s.stamp
  -- RE-CHECK TWO: after the dispatch permission, at the send. Every attempt.
  | .permit n => s.push t (.permit n) (.enter n .atSend) s.stamp
  | .send n =>
    if r.route = .llm then
      s.push t (.send n) (.settle n (!t.ok && decide (n < r.fallbacks))) s.stamp
    else s.push t (.send n) .respond s.stamp
  | .settle n failover =>
    if failover = true then s.push t (.settle n) (.enter (n + 1) .qualify) s.stamp
    else s.push t (.settle n) .respond s.stamp
  | .closing n .atSend => s.push t (.settleZero n) (.refused n .atSend) s.stamp
  | .closing n .admission => s.push t (.release n) (.refused n .admission) s.stamp
  | .closing n .beforeKey => s.push t (.release n) (.refused n .beforeKey) s.stamp
  | .closing n .qualify => s.push t (.release n) (.refused n .qualify) s.stamp
  | .closing n .beforeHold => s.push t (.release n) (.refused n .beforeHold) s.stamp
  | .refused n ph => s.push t (.refuse n ph) .done s.stamp
  | .stopping n => s.push t (.stopFailover n) .respond s.stamp
  | .respond => s.push t .respond .done s.stamp
  | .done => s

def step (cfg : Cfg) (r : Req) (t : Tick) (s : St) : St := stepAt cfg r t s s.pc

/-- A request that has just arrived in world `w`. -/
def init (w : World) : St :=
  { pc := .enter 0 .admission, stamp := fun _ => 0, w := w, trace := [] }

/-- The request after the environment has played `ticks`. Every list of ticks
    is one possible run, cut off at one possible point. -/
def exec (cfg : Cfg) (r : Req) (w : World) (ticks : List Tick) : St :=
  ticks.foldl (fun s t => step cfg r t s) (init w)

/-- The attempts that were sent, oldest first. -/
def sent (s : St) : List Nat :=
  s.trace.reverse.filterMap (fun f => match f.act with | .send n => some n | _ => none)

/-- The steps, oldest first. -/
def acts (s : St) : List Action := s.trace.reverse.map (fun f => f.act)

/-! ## What the proof carries from step to step -/

/-- Does this step read stop `a`? -/
def Frame.reads (f : Frame) (a : Stop) : Bool :=
  match f.act with
  | .read _ _ _ L => decide (a ∈ L)
  | _ => false

/-- The most recent read of `a` in a trace. -/
def lastRead (a : Stop) (tr : List Frame) : Option Frame := tr.find? (fun f => f.reads a)

/-- Expiry was read by the check at the send of attempt `n` that began at `t0`. -/
def ExpiryReadHere (tr : List Frame) (n t0 : Nat) : Prop :=
  ∃ h, lastRead .expiry tr = some h ∧ h.act = .read n .atSend t0 [.expiry]

/-- What is true of the trace before a send of attempt `n`. -/
def SendOK (cfg : Cfg) (r : Req) (n : Nat) (older : List Frame) : Prop :=
  ∃ f rest t0, older = f :: rest ∧ f.act = .read n .atSend t0 (redisStops r) ∧
    (∀ x ∈ redisStops r, refusesOn cfg f.w x = false) ∧
    (∀ a, a.isRedis = false → applies r a = true →
      ∃ h m ph th L, lastRead a older = some h ∧ h.act = .read m ph th L ∧ a ∈ L ∧
        refusesOn cfg h.w a = false ∧ th ≤ h.w.now ∧
        (rereads cfg a = true → t0 ≤ th + cfg.maxAge ∧ (0 < n → m = n))) ∧
    (rereads cfg .expiry = true → applies r .expiry = true → ExpiryReadHere older n t0)

def AllSendsOK (cfg : Cfg) (r : Req) : List Frame → Prop
  | [] => True
  | g :: older => (∀ n, g.act = .send n → SendOK cfg r n older) ∧ AllSendsOK cfg r older

/-- Authority `a` was last read clear, at the time its stamp says. -/
def Auth (cfg : Cfg) (s : St) (a : Stop) (P : Nat → Prop) : Prop :=
  ∃ h m ph th L, lastRead a s.trace = some h ∧ h.act = .read m ph th L ∧ a ∈ L ∧
    refusesOn cfg h.w a = false ∧ th = s.stamp a ∧ th ≤ h.w.now ∧ P m

def Live (cfg : Cfg) (r : Req) (s : St) (P : Stop → Nat → Prop) : Prop :=
  ∀ a, a.isRedis = false → applies r a = true → Auth cfg s a (P a)

def Held (r : Req) (s : St) (n : Nat) : Prop := r.route = .llm → ∃ h ∈ s.trace, h.act = .hold n

def loose (_ : Stop) (_ : Nat) : Prop := True

/-- On a failover, an authority the re-check reads was read inside the attempt. -/
def tight (cfg : Cfg) (n : Nat) (a : Stop) (m : Nat) : Prop :=
  0 < n → rereads cfg a = true → m = n

def SendReady (cfg : Cfg) (r : Req) (s : St) (n : Nat) : Prop :=
  ∃ f rest t0, s.trace = f :: rest ∧ f.act = .read n .atSend t0 (redisStops r) ∧
    (∀ x ∈ redisStops r, refusesOn cfg f.w x = false) ∧
    (∀ a, a.isRedis = false → applies r a = true → rereads cfg a = true →
      t0 ≤ s.stamp a + cfg.maxAge) ∧
    (rereads cfg .expiry = true → applies r .expiry = true → ExpiryReadHere s.trace n t0)

def CloseOK (r : Req) (tr : List Frame) (n : Nat) (ph : Phase) : Prop :=
  (ph = .beforeKey ∨ ph = .atSend) → r.route = .llm →
    ∃ f rest, tr = f :: rest ∧ (f.act = .release n ∨ f.act = .settleZero n) ∧
      ∃ h ∈ rest, h.act = .hold n

def EnterPre (cfg : Cfg) (r : Req) (s : St) (n : Nat) : Phase → Prop
  | .admission => True
  | .beforeKey => Live cfg r s loose ∧ Held r s n
  | .atSend => Live cfg r s (tight cfg n) ∧ Held r s n
  | .qualify => Live cfg r s loose
  | .beforeHold => True

def CheckPre (cfg : Cfg) (r : Req) (s : St) (n : Nat) (t0 : Nat) (todo : List Stop) :
    Phase → Prop
  | .admission =>
    ∃ seen, authorityOrder.filter (applies r) = seen ++ todo ∧ ∀ a ∈ seen, Auth cfg s a (loose a)
  | .beforeKey =>
    Live cfg r s (fun a m => 0 < n → rereads cfg a = true → a ∉ todo → m = n) ∧ Held r s n
  | .atSend =>
    Live cfg r s (tight cfg n) ∧ Held r s n ∧
      (∀ a, a.isRedis = false → applies r a = true → rereads cfg a = true → a ∉ todo →
        t0 ≤ s.stamp a + cfg.maxAge) ∧
      (rereads cfg .expiry = true → applies r .expiry = true → .expiry ∉ todo →
        ExpiryReadHere s.trace n t0)
  | .qualify => Live cfg r s loose
  | .beforeHold => True

def PcInv (cfg : Cfg) (r : Req) : Pc → St → Prop
  | .enter n ph, s => EnterPre cfg r s n ph
  | .check n ph t0 todo, s => (ph = .admission ∨ t0 ≤ s.w.now) ∧ CheckPre cfg r s n t0 todo ph
  | .body, s => Live cfg r s loose
  | .approval, s => Live cfg r s loose
  | .hold _, s => Live cfg r s loose
  | .key n, s => Live cfg r s (tight cfg n) ∧ Held r s n
  | .permit n, s => Live cfg r s (tight cfg n) ∧ Held r s n
  | .send n, s => Live cfg r s (tight cfg n) ∧ SendReady cfg r s n
  | .settle _ _, s => Live cfg r s loose
  | .closing n _, s => Held r s n
  | .refused n ph, s => CloseOK r s.trace n ph
  | .stopping _, _ => True
  | .respond, _ => True
  | .done, _ => True

def NoRefuse (tr : List Frame) : Prop := ∀ f ∈ tr, ∀ n ph, f.act ≠ .refuse n ph

def Final (r : Req) : List Frame → Prop
  | [] => True
  | g :: older => NoRefuse older ∧ ∀ n ph, g.act = .refuse n ph → CloseOK r older n ph

/-- Everything that stays true from one step to the next. -/
structure Inv (cfg : Cfg) (r : Req) (s : St) : Prop where
  sends : AllSendsOK cfg r s.trace
  running : s.pc ≠ .done → NoRefuse s.trace
  ended : s.pc = .done → Final r s.trace
  here : PcInv cfg r s.pc s

/-! ## Lemmas -/

theorem lastRead_cons (a : Stop) (f : Frame) (tr : List Frame) :
    lastRead a (f :: tr) = if f.reads a = true then some f else lastRead a tr := by
  unfold lastRead
  rw [List.find?_cons]
  cases h : f.reads a <;> simp

theorem not_mem_redisStops {r : Req} {a : Stop} (h : a.isRedis = false) : a ∉ redisStops r := by
  unfold redisStops
  split <;> cases a <;> simp_all [Stop.isRedis]

theorem mem_redisStops {r : Req} {x : Stop} (h : x.isRedis = true) (ha : applies r x = true) :
    x ∈ redisStops r := by
  unfold redisStops
  split <;> cases x <;> simp_all [Stop.isRedis, applies]

theorem mem_authorityOrder {a : Stop} (h : a.isRedis = false) : a ∈ authorityOrder := by
  cases a <;> simp_all [Stop.isRedis, authorityOrder]

theorem forced_is_due {cfg : Cfg} {r : Req} {stamp : Stop → Nat} {n t0 : Nat} {a : Stop}
    (ha : a.isRedis = false) (hap : applies r a = true) (hrr : rereads cfg a = true)
    (hn : 0 < n) : a ∈ due cfg r stamp n .beforeKey t0 := by
  simp only [due, List.mem_filter]
  refine ⟨mem_authorityOrder ha, ?_⟩
  simp only [isDue, hap, Bool.true_and]
  by_cases he : a = .expiry
  · subst he; simpa [rereads] using hrr
  · simp [he, hn]

theorem not_due_is_fresh {cfg : Cfg} {r : Req} {stamp : Stop → Nat} {n t0 : Nat} {a : Stop}
    (ha : a.isRedis = false) (hap : applies r a = true) (hrr : rereads cfg a = true)
    (hnd : a ∉ due cfg r stamp n .atSend t0) : t0 ≤ stamp a + cfg.maxAge := by
  simp only [due, List.mem_filter, not_and] at hnd
  have h := hnd (mem_authorityOrder ha)
  simp only [isDue, hap, Bool.true_and] at h
  by_cases he : a = .expiry
  · subst he
    simp [rereads] at hrr
    simp [hrr] at h
  · simp [he] at h
    omega

theorem expiry_is_due_at_the_send {cfg : Cfg} {r : Req} {stamp : Stop → Nat} {n t0 : Nat}
    (hrr : rereads cfg .expiry = true) (hap : applies r .expiry = true) :
    Stop.expiry ∈ due cfg r stamp n .atSend t0 := by
  have h : cfg.rereadsExpiry = true := by simpa [rereads] using hrr
  simp [due, authorityOrder, isDue, hap, h]

theorem ExpiryReadHere.keep {tr : List Frame} {n t0 : Nat} {f : Frame}
    (h : ExpiryReadHere tr n t0) (hf : f.reads .expiry = false) :
    ExpiryReadHere (f :: tr) n t0 := by
  obtain ⟨g, hl, ha⟩ := h
  exact ⟨g, by rw [lastRead_cons, hf]; simpa using hl, ha⟩

theorem Auth.keep {cfg : Cfg} {s s' : St} {a : Stop} {P P' : Nat → Prop} {f : Frame}
    (h : Auth cfg s a P) (htr : s'.trace = f :: s.trace) (hf : f.reads a = false)
    (hst : s'.stamp a = s.stamp a) (hP : ∀ m, P m → P' m) : Auth cfg s' a P' := by
  obtain ⟨g, m, ph, th, L, hl, hact, hmem, hclear, hth, hnow, hp⟩ := h
  refine ⟨g, m, ph, th, L, ?_, hact, hmem, hclear, ?_, hnow, hP m hp⟩
  · rw [htr, lastRead_cons, hf]; simpa using hl
  · rw [hst]; exact hth

theorem Auth.fresh {cfg : Cfg} {s' : St} {a : Stop} {P' : Nat → Prop} {f : Frame}
    {tr : List Frame} {n : Nat} {ph : Phase} {th : Nat} {L : List Stop}
    (htr : s'.trace = f :: tr) (hact : f.act = .read n ph th L) (hmem : a ∈ L)
    (hclear : refusesOn cfg f.w a = false) (hst : th = s'.stamp a) (hnow : th ≤ f.w.now)
    (hp : P' n) : Auth cfg s' a P' := by
  refine ⟨f, n, ph, th, L, ?_, hact, hmem, hclear, hst, hnow, hp⟩
  have hr : f.reads a = true := by simp [Frame.reads, hact, hmem]
  rw [htr, lastRead_cons, hr]; simp

theorem Live.keep {cfg : Cfg} {r : Req} {s s' : St} {P P' : Stop → Nat → Prop} {f : Frame}
    (h : Live cfg r s P) (htr : s'.trace = f :: s.trace)
    (hf : ∀ a, a.isRedis = false → f.reads a = false) (hst : s'.stamp = s.stamp)
    (hP : ∀ a m, a.isRedis = false → applies r a = true → P a m → P' a m) :
    Live cfg r s' P' :=
  fun a ha hap => (h a ha hap).keep htr (hf a ha) (by rw [hst]) (fun m => hP a m ha hap)

theorem Held.keep {r : Req} {s s' : St} {n : Nat} {f : Frame} (h : Held r s n)
    (htr : s'.trace = f :: s.trace) : Held r s' n := by
  intro hl
  obtain ⟨g, hg, ha⟩ := h hl
  exact ⟨g, by rw [htr]; exact List.mem_cons_of_mem _ hg, ha⟩

/-- A Redis read reads no authority. -/
theorem redis_frame_reads_no_authority {r : Req} {pre : List Event} {w : World} {n : Nat}
    {ph : Phase} {t0 : Nat} (a : Stop) (ha : a.isRedis = false) :
    (Frame.mk pre w (.read n ph t0 (redisStops r))).reads a = false := by
  simp [Frame.reads, not_mem_redisStops ha]

theorem inv_push {cfg : Cfg} {r : Req} {s : St} (t : Tick) (act : Action) (pc' : Pc)
    (st' : Stop → Nat) (hs : AllSendsOK cfg r s.trace) (hno : NoRefuse s.trace)
    (hsend : ∀ n, act = .send n → SendOK cfg r n s.trace)
    (href : ∀ n ph, act = .refuse n ph → pc' = .done ∧ CloseOK r s.trace n ph)
    (hpc : PcInv cfg r pc' (s.push t act pc' st')) : Inv cfg r (s.push t act pc' st') where
  sends := ⟨hsend, hs⟩
  running := by
    intro hne f hf n ph hact
    simp only [St.push, List.mem_cons] at hf
    rcases hf with rfl | hf
    · exact hne (href n ph hact).1
    · exact hno f hf n ph hact
  ended := fun _ => ⟨hno, fun n ph h => (href n ph h).2⟩
  here := hpc

theorem sendOK_of_ready {cfg : Cfg} {r : Req} {s : St} {n : Nat}
    (hl : Live cfg r s (tight cfg n)) (hr : SendReady cfg r s n) : SendOK cfg r n s.trace := by
  obtain ⟨f, rest, t0, htr, hact, hclear, hfresh, hexp⟩ := hr
  refine ⟨f, rest, t0, htr, hact, hclear, ?_, hexp⟩
  intro a ha hap
  obtain ⟨h, m, ph, th, L, hlr, hha, hmem, hcl, hth, hnow, hp⟩ := hl a ha hap
  refine ⟨h, m, ph, th, L, hlr, hha, hmem, hcl, hnow, ?_⟩
  intro hrr
  exact ⟨by rw [hth]; exact hfresh a ha hap hrr, fun hn => hp hn hrr⟩

theorem pcinv_refusal {cfg : Cfg} {r : Req} {s : St} {t : Tick} {act : Action} {n : Nat}
    {ph : Phase} (hheld : (ph = .beforeKey ∨ ph = .atSend) → Held r s n) :
    PcInv cfg r (refusalPc r n ph) (s.push t act (refusalPc r n ph) s.stamp) := by
  cases ph with
  | admission =>
    simp only [refusalPc, PcInv, CloseOK]
    intro h; rcases h with h | h <;> cases h
  | qualify => simp only [refusalPc, PcInv]
  | beforeHold =>
    simp only [refusalPc, PcInv, CloseOK]
    intro h; rcases h with h | h <;> cases h
  | beforeKey =>
    by_cases hl : r.route = .llm
    · have e : refusalPc r n .beforeKey = .closing n .beforeKey := by simp [refusalPc, hl]
      rw [e]
      exact (hheld (Or.inl rfl)).keep rfl
    · have e : refusalPc r n .beforeKey = .refused n .beforeKey := by simp [refusalPc, hl]
      rw [e]
      intro _ h; exact absurd h hl
  | atSend =>
    by_cases hl : r.route = .llm
    · have e : refusalPc r n .atSend = .closing n .atSend := by simp [refusalPc, hl]
      rw [e]
      exact (hheld (Or.inr rfl)).keep rfl
    · have e : refusalPc r n .atSend = .refused n .atSend := by simp [refusalPc, hl]
      rw [e]
      intro _ h; exact absurd h hl

/-- After an authority read that came back clear. -/
theorem auth_after_read {cfg : Cfg} {s : St} {t : Tick} {n : Nat} {ph : Phase} {t0 : Nat}
    {a : Stop} {pc' : Pc} {P P' : Stop → Nat → Prop} (b : Stop)
    (hclear : refusesOn cfg (s.w.after t.events) a = false)
    (hstart : startOf ph t0 (s.w.after t.events) ≤ (s.w.after t.events).now)
    (hold : b ≠ a → Auth cfg s b (P b)) (hP : ∀ m, b ≠ a → P b m → P' b m)
    (hnew : b = a → P' b n) :
    Auth cfg
      (s.push t (.read n ph (startOf ph t0 (s.w.after t.events)) [a]) pc'
        (fun x => if x = a then startOf ph t0 (s.w.after t.events) else s.stamp x)) b (P' b) := by
  by_cases hb : b = a
  · subst hb
    exact Auth.fresh (tr := s.trace) rfl rfl (by simp) hclear (by simp [St.push]) hstart (hnew rfl)
  · exact (hold hb).keep (f := ⟨t.events, s.w.after t.events, _⟩) rfl
      (by simp [Frame.reads, hb]) (by simp [St.push, hb]) (fun m => hP m hb)

theorem stepCheck_inv {cfg : Cfg} {r : Req} (t : Tick) (s : St) (n : Nat) (ph : Phase) (t0 : Nat)
    (todo : List Stop) (hs : AllSendsOK cfg r s.trace) (hno : NoRefuse s.trace)
    (ht : ph = .admission ∨ t0 ≤ (s.w.after t.events).now)
    (hpre : CheckPre cfg r s n t0 todo ph) :
    Inv cfg r (stepCheck cfg r t s n ph t0 todo) := by
  have hstart : startOf ph t0 (s.w.after t.events) ≤ (s.w.after t.events).now := by
    cases ph <;> simp only [startOf] <;>
      first
        | exact Nat.le_refl _
        | (rcases ht with h | h
           · cases h
           · exact h)
  have hheld : (ph = .beforeKey ∨ ph = .atSend) → Held r s n := by
    intro h
    rcases h with h | h <;> subst h
    · exact hpre.2
    · exact hpre.2.1
  cases todo with
  | cons a rest =>
    simp only [stepCheck]
    split
    · exact inv_push t _ _ _ hs hno (by intro n h; cases h) (by intro n ph h; cases h)
        (pcinv_refusal hheld)
    · rename_i hc
      have hclear : refusesOn cfg (s.w.after t.events) a = false := by simpa using hc
      refine inv_push t _ _ _ hs hno (by intro n h; cases h) (by intro n ph h; cases h) ?_
      simp only [PcInv]
      refine ⟨ht, ?_⟩
      cases ph with
      | admission =>
        obtain ⟨seen, hd, hall⟩ := hpre
        refine ⟨seen ++ [a], by rw [hd]; simp, ?_⟩
        intro b hb
        refine auth_after_read (P := loose) (P' := loose) b hclear hstart ?_
          (fun _ _ h => h) (fun _ => trivial)
        intro hne
        rcases List.mem_append.mp hb with h | h
        · exact hall b h
        · exact absurd (by simpa using h) hne
      | beforeKey =>
        refine ⟨?_, hpre.2.keep rfl⟩
        intro b hb hap
        refine auth_after_read
          (P := fun a' m => 0 < n → rereads cfg a' = true → a' ∉ a :: rest → m = n)
          (P' := fun a' m => 0 < n → rereads cfg a' = true → a' ∉ rest → m = n)
          b hclear hstart (fun _ => hpre.1 b hb hap) ?_ (fun _ _ _ _ => rfl)
        intro m hne h hn hrr hnot
        exact h hn hrr (by simp [hne, hnot])
      | atSend =>
        refine ⟨?_, hpre.2.1.keep rfl, ?_, ?_⟩
        · intro b hb hap
          exact auth_after_read (P := tight cfg n) (P' := tight cfg n) b hclear hstart
            (fun _ => hpre.1 b hb hap) (fun _ _ h => h) (fun _ _ _ => rfl)
        rotate_left
        · intro hrr hap hnot
          by_cases he : a = .expiry
          · subst he
            refine ⟨⟨t.events, s.w.after t.events, .read n .atSend t0 [.expiry]⟩, ?_, rfl⟩
            show lastRead .expiry (_ :: s.trace) = _
            rw [lastRead_cons]; simp [Frame.reads]; rfl
          · have hne : Stop.expiry ≠ a := fun h => he h.symm
            exact (hpre.2.2.2 hrr hap (by simp [hne, hnot])).keep (by simp [Frame.reads, hne])
        · intro b hb hap hrr hnot
          by_cases hba : b = a
          · simp [St.push, hba, startOf]
          · have e : (if b = a then startOf .atSend t0 (s.w.after t.events) else s.stamp b)
                = s.stamp b := by simp [hba]
            show t0 ≤ (if b = a then startOf .atSend t0 (s.w.after t.events) else s.stamp b)
              + cfg.maxAge
            rw [e]
            exact hpre.2.2.1 b hb hap hrr (by simp [hba, hnot])
      | qualify =>
        intro b hb hap
        exact auth_after_read (P := loose) (P' := loose) b hclear hstart
          (fun _ => hpre b hb hap) (fun _ _ h => h) (fun _ => trivial)
      | beforeHold => trivial
  | nil =>
    simp only [stepCheck]
    split
    · exact inv_push t _ _ _ hs hno (by intro n h; cases h) (by intro n ph h; cases h)
        (pcinv_refusal hheld)
    · rename_i hc
      have hclear : ∀ x ∈ redisStops r, refusesOn cfg (s.w.after t.events) x = false := by
        intro x hx
        cases hv : refusesOn cfg (s.w.after t.events) x with
        | false => rfl
        | true => exact absurd (List.any_eq_true.mpr ⟨x, hx, hv⟩) hc
      cases ph with
      | admission =>
        dsimp only
        refine inv_push t _ _ _ hs hno (by intro n h; cases h) (by intro n ph h; cases h) ?_
        obtain ⟨seen, hd, hall⟩ := hpre
        intro b hb hap
        have hmem : b ∈ seen := by
          have : b ∈ authorityOrder.filter (applies r) :=
            List.mem_filter.mpr ⟨mem_authorityOrder hb, hap⟩
          rw [hd] at this; simpa using this
        exact (hall b hmem).keep rfl (redis_frame_reads_no_authority b hb) rfl (fun _ h => h)
      | beforeKey =>
        dsimp only
        refine inv_push t _ _ _ hs hno (by intro n h; cases h) (by intro n ph h; cases h) ?_
        refine ⟨?_, hpre.2.keep rfl⟩
        exact hpre.1.keep rfl (fun a ha => redis_frame_reads_no_authority a ha) rfl
          (fun b m _ _ h hn hrr => h hn hrr (by simp))
      | atSend =>
        dsimp only
        refine inv_push t _ _ _ hs hno (by intro n h; cases h) (by intro n ph h; cases h) ?_
        refine ⟨?_, ?_⟩
        · exact hpre.1.keep rfl (fun a ha => redis_frame_reads_no_authority a ha) rfl
            (fun _ _ _ _ h => h)
        · exact ⟨_, _, t0, rfl, rfl, hclear,
            fun b hb hap hrr => hpre.2.2.1 b hb hap hrr (by simp),
            fun hrr hap => (hpre.2.2.2 hrr hap (by simp)).keep
              (redis_frame_reads_no_authority .expiry rfl)⟩
      | qualify =>
        dsimp only
        split
        · refine inv_push t _ _ _ hs hno (by intro n h; cases h) (by intro n ph h; cases h) ?_
          exact hpre.keep rfl (fun a ha => redis_frame_reads_no_authority a ha) rfl
            (fun _ _ _ _ h => h)
        · exact inv_push t _ _ _ hs hno (by intro n h; cases h) (by intro n ph h; cases h) trivial
      | beforeHold =>
        dsimp only
        exact inv_push t _ _ _ hs hno (by intro n h; cases h) (by intro n ph h; cases h) trivial

/-- A step that is not a read, a send or a refusal keeps what is known. -/
theorem live_push {cfg : Cfg} {r : Req} {s : St} {P P' : Stop → Nat → Prop} {t : Tick}
    {act : Action} {pc' : Pc} (h : Live cfg r s P)
    (hf : ∀ a, a.isRedis = false → (Frame.mk t.events (s.w.after t.events) act).reads a = false)
    (hP : ∀ a m, a.isRedis = false → applies r a = true → P a m → P' a m) :
    Live cfg r (s.push t act pc' s.stamp) P' :=
  h.keep rfl hf rfl hP

theorem step_inv {cfg : Cfg} {r : Req} (t : Tick) {s : St} (hi : Inv cfg r s) :
    Inv cfg r (step cfg r t s) := by
  have hp := hi.here
  unfold step
  cases hc : s.pc with
  | done => simpa only [stepAt] using hi
  | enter n ph =>
    rw [hc] at hp
    have hno : NoRefuse s.trace := hi.running (by simp [hc])
    simp only [stepAt]
    refine stepCheck_inv t s n ph _ _ hi.sends hno (Or.inr (Nat.le_refl _)) ?_
    cases ph with
    | admission => exact ⟨[], by simp [due], fun _ h => by cases h⟩
    | beforeKey =>
      refine ⟨?_, hp.2⟩
      intro a ha hap
      obtain ⟨h, m, ph', th, L, h1, h2, h3, h4, h5, h6, _⟩ := hp.1 a ha hap
      exact ⟨h, m, ph', th, L, h1, h2, h3, h4, h5, h6,
        fun hn hrr hnot => absurd (forced_is_due ha hap hrr hn) hnot⟩
    | atSend =>
      exact ⟨hp.1, hp.2, fun a ha hap hrr hnot => not_due_is_fresh ha hap hrr hnot,
        fun hrr hap hnot => absurd (expiry_is_due_at_the_send hrr hap) hnot⟩
    | qualify => exact hp
    | beforeHold => trivial
  | check n ph t0 todo =>
    rw [hc] at hp
    have hno : NoRefuse s.trace := hi.running (by simp [hc])
    simp only [stepAt]
    refine stepCheck_inv t s n ph t0 todo hi.sends hno ?_ hp.2
    rcases hp.1 with h | h
    · exact Or.inl h
    · exact Or.inr (Nat.le_trans h (clock_never_runs_back _ _))
  | body =>
    rw [hc] at hp
    have hno : NoRefuse s.trace := hi.running (by simp [hc])
    simp only [stepAt]
    split
    · exact inv_push t _ _ _ hi.sends hno (by intro n h; cases h) (by intro n ph h; cases h)
        (live_push hp (fun _ _ => rfl) (fun _ _ _ _ h => h))
    · split
      · exact inv_push t _ _ _ hi.sends hno (by intro n h; cases h) (by intro n ph h; cases h)
          (live_push hp (fun _ _ => rfl) (fun _ _ _ _ h => h))
      · rename_i hl
        exact inv_push t _ _ _ hi.sends hno (by intro n h; cases h) (by intro n ph h; cases h)
          ⟨live_push hp (fun _ _ => rfl) (fun _ _ _ _ h => h), fun h => absurd h hl⟩
  | approval =>
    rw [hc] at hp
    have hno : NoRefuse s.trace := hi.running (by simp [hc])
    simp only [stepAt]
    split
    · exact inv_push t _ _ _ hi.sends hno (by intro n h; cases h) (by intro n ph h; cases h)
        (live_push hp (fun _ _ => rfl) (fun _ _ _ _ h => h))
    · rename_i hl
      exact inv_push t _ _ _ hi.sends hno (by intro n h; cases h) (by intro n ph h; cases h)
        ⟨live_push hp (fun _ _ => rfl) (fun _ _ _ _ h => h), fun h => absurd h hl⟩
  | hold n =>
    rw [hc] at hp
    have hno : NoRefuse s.trace := hi.running (by simp [hc])
    simp only [stepAt]
    split
    · exact
        { sends := hi.sends
          running := fun _ => hno
          ended := fun h => by cases h
          here := by
            show CloseOK r s.trace n .beforeHold
            intro h; rcases h with h | h <;> cases h }
    · exact inv_push t _ _ _ hi.sends hno (by intro n h; cases h) (by intro n ph h; cases h)
        ⟨live_push hp (fun _ _ => rfl) (fun _ _ _ _ h => h), fun _ => ⟨_, List.Mem.head _, rfl⟩⟩
  | key n =>
    rw [hc] at hp
    have hno : NoRefuse s.trace := hi.running (by simp [hc])
    simp only [stepAt]
    split
    · exact inv_push t _ _ _ hi.sends hno (by intro n h; cases h) (by intro n ph h; cases h)
        ⟨live_push hp.1 (fun _ _ => rfl) (fun _ _ _ _ h => h), hp.2.keep rfl⟩
    · exact inv_push t _ _ _ hi.sends hno (by intro n h; cases h) (by intro n ph h; cases h)
        ⟨live_push hp.1 (fun _ _ => rfl) (fun _ _ _ _ h => h), hp.2.keep rfl⟩
  | permit n =>
    rw [hc] at hp
    have hno : NoRefuse s.trace := hi.running (by simp [hc])
    simp only [stepAt]
    exact inv_push t _ _ _ hi.sends hno (by intro n h; cases h) (by intro n ph h; cases h)
      ⟨live_push hp.1 (fun _ _ => rfl) (fun _ _ _ _ h => h), hp.2.keep rfl⟩
  | send n =>
    rw [hc] at hp
    have hno : NoRefuse s.trace := hi.running (by simp [hc])
    have hok : ∀ m, Action.send n = .send m → SendOK cfg r m s.trace := by
      intro m h; cases h; exact sendOK_of_ready hp.1 hp.2
    simp only [stepAt]
    split
    · exact inv_push t _ _ _ hi.sends hno hok (by intro n ph h; cases h)
        (live_push hp.1 (fun _ _ => rfl) (fun _ _ _ _ _ => trivial))
    · exact inv_push t _ _ _ hi.sends hno hok (by intro n ph h; cases h) trivial
  | settle n failover =>
    rw [hc] at hp
    have hno : NoRefuse s.trace := hi.running (by simp [hc])
    simp only [stepAt]
    split
    · exact inv_push t _ _ _ hi.sends hno (by intro n h; cases h) (by intro n ph h; cases h)
        (live_push hp (fun _ _ => rfl) (fun _ _ _ _ h => h))
    · exact inv_push t _ _ _ hi.sends hno (by intro n h; cases h) (by intro n ph h; cases h) trivial
  | closing n ph =>
    rw [hc] at hp
    have hno : NoRefuse s.trace := hi.running (by simp [hc])
    cases ph <;> simp only [stepAt] <;>
      refine inv_push t _ _ _ hi.sends hno (by intro n h; cases h) (by intro n ph h; cases h) ?_ <;>
      intro _ hl <;>
      obtain ⟨h, hh, ha⟩ := hp hl
    · exact ⟨_, _, rfl, Or.inl rfl, h, hh, ha⟩
    · exact ⟨_, _, rfl, Or.inl rfl, h, hh, ha⟩
    · exact ⟨_, _, rfl, Or.inr rfl, h, hh, ha⟩
    · exact ⟨_, _, rfl, Or.inl rfl, h, hh, ha⟩
    · exact ⟨_, _, rfl, Or.inl rfl, h, hh, ha⟩
  | refused n ph =>
    rw [hc] at hp
    have hno : NoRefuse s.trace := hi.running (by simp [hc])
    simp only [stepAt]
    exact inv_push t _ _ _ hi.sends hno (by intro n h; cases h)
      (by intro n' ph' h; cases h; exact ⟨rfl, hp⟩) trivial
  | stopping n =>
    have hno : NoRefuse s.trace := hi.running (by simp [hc])
    simp only [stepAt]
    exact inv_push t _ _ _ hi.sends hno (by intro n h; cases h) (by intro n ph h; cases h) trivial
  | respond =>
    have hno : NoRefuse s.trace := hi.running (by simp [hc])
    simp only [stepAt]
    exact inv_push t _ _ _ hi.sends hno (by intro n h; cases h) (by intro n ph h; cases h) trivial

theorem init_inv (cfg : Cfg) (r : Req) (w : World) : Inv cfg r (init w) where
  sends := trivial
  running := fun _ f hf => by cases hf
  ended := fun h => by cases h
  here := trivial

/-- THE INVARIANT HOLDS AT EVERY POINT OF EVERY RUN. -/
theorem exec_inv (cfg : Cfg) (r : Req) (w : World) (ticks : List Tick) :
    Inv cfg r (exec cfg r w ticks) := by
  unfold exec
  have h : ∀ (ticks : List Tick) (s : St), Inv cfg r s →
      Inv cfg r (ticks.foldl (fun s t => step cfg r t s) s) := by
    intro ticks
    induction ticks with
    | nil => intro s h; exact h
    | cons t ts ih => intro s h; exact ih _ (step_inv t h)
  exact h ticks _ (init_inv cfg r w)

theorem allSendsOK_split {cfg : Cfg} {r : Req} {n : Nat} {g : Frame} {older : List Frame} :
    ∀ (post tr : List Frame), AllSendsOK cfg r tr → tr = post ++ g :: older →
      g.act = .send n → SendOK cfg r n older
  | [], _, h, htr, hg => by subst htr; exact h.1 n hg
  | _ :: post, _, h, htr, hg => by subst htr; exact allSendsOK_split post _ h.2 rfl hg

/-- Whatever precedes a send in any run satisfies `SendOK`. -/
theorem send_ok {cfg : Cfg} {r : Req} {w : World} {ticks : List Tick} {post : List Frame}
    {g : Frame} {older : List Frame} {n : Nat}
    (htr : (exec cfg r w ticks).trace = post ++ g :: older) (hg : g.act = .send n) :
    SendOK cfg r n older :=
  allSendsOK_split post _ (exec_inv cfg r w ticks).sends htr hg

/-! # HEADLINE THEOREMS

Every theorem below is about `exec cfg r w ticks` for ANY configuration, request,
starting world and list of ticks: every run, cut off at every point. A trace is
newest first, so `trace = post ++ g :: older` reads: `g` is some step, `older`
is everything before it, `post` is everything after.

## 0. The trace is a timeline -/

/-- Each step sees the world left by the events before it, and nothing else
    changes the world. -/
def Timeline (w0 : World) : List Frame → Prop
  | [] => True
  | [f] => f.w = w0.after f.pre
  | g :: f :: rest => g.w = f.w.after g.pre ∧ Timeline w0 (f :: rest)

theorem step_is_push (cfg : Cfg) (r : Req) (t : Tick) (s : St) :
    ((step cfg r t s).trace = s.trace ∧ (step cfg r t s).w = s.w) ∨
      ∃ act pc' st', step cfg r t s = s.push t act pc' st' := by
  unfold step
  cases s.pc with
  | done => exact Or.inl ⟨rfl, rfl⟩
  | hold n =>
    simp only [stepAt]
    split
    · exact Or.inl ⟨rfl, rfl⟩
    · exact Or.inr ⟨_, _, _, rfl⟩
  | enter n ph =>
    simp only [stepAt]
    unfold stepCheck
    repeat' (first | exact Or.inr ⟨_, _, _, rfl⟩ | split)
  | check n ph t0 todo =>
    simp only [stepAt]
    unfold stepCheck
    repeat' (first | exact Or.inr ⟨_, _, _, rfl⟩ | split)
  | closing n ph => cases ph <;> exact Or.inr ⟨_, _, _, rfl⟩
  | _ =>
    simp only [stepAt]
    repeat' (first | exact Or.inr ⟨_, _, _, rfl⟩ | split)

theorem the_trace_is_a_timeline (cfg : Cfg) (r : Req) (w : World) (ticks : List Tick) :
    Timeline w (exec cfg r w ticks).trace := by
  unfold exec
  have h : ∀ (ticks : List Tick) (s : St),
      (Timeline w s.trace ∧ s.w = (match s.trace with | [] => w | f :: _ => f.w)) →
      Timeline w (ticks.foldl (fun s t => step cfg r t s) s).trace := by
    intro ticks
    induction ticks with
    | nil => intro s h; exact h.1
    | cons t ts ih =>
      intro s h
      refine ih (step cfg r t s) ?_
      rcases step_is_push cfg r t s with he | ⟨act, pc', st', he⟩
      · rw [he.1, he.2]; exact h
      · rw [he]
        refine ⟨?_, rfl⟩
        cases htr : s.trace with
        | nil =>
          have hw : s.w = w := by have := h.2; rw [htr] at this; exact this
          simp only [St.push, htr, Timeline, hw]
        | cons f rest =>
          have hw : s.w = f.w := by have := h.2; rw [htr] at this; exact this
          have h1 := h.1
          rw [htr] at h1
          simp only [St.push, htr, Timeline, hw]
          exact ⟨trivial, h1⟩
  exact h ticks _ ⟨trivial, rfl⟩

/-! ## 1. Fresh read before every send -/

/-- THEOREM 1. The step immediately before EVERY upstream send, first attempt or
    failover, LLM route or service route, is a read of the Redis stops made by
    that attempt's own check at the send. That one read covers every Redis stop
    that applies: platform, tenant, denylist, session, suspend, and the
    per-service stop on the service route.

    The authority stops the re-check reads (delegation, mission, Direct Agent
    Key) are NOT always read in that last step. What holds for them is the
    second half: each was read, and its latest read belongs to a check that
    began no more than `maxAge` (2 s) before the check at the send began. On a
    failover that read was made inside the failover attempt itself. -/
theorem fresh_read_before_every_send (cfg : Cfg) (r : Req) (w : World) (ticks : List Tick)
    {post : List Frame} {g : Frame} {older : List Frame} {n : Nat}
    (htr : (exec cfg r w ticks).trace = post ++ g :: older) (hg : g.act = .send n) :
    ∃ f rest t0, older = f :: rest ∧ f.act = .read n .atSend t0 (redisStops r) ∧
      (∀ x, x.isRedis = true → applies r x = true → x ∈ redisStops r) ∧
      (∀ a, a.isRedis = false → applies r a = true → rereads cfg a = true →
        ∃ h m ph th L, lastRead a older = some h ∧ h.act = .read m ph th L ∧ a ∈ L ∧
          th ≤ h.w.now ∧ t0 ≤ th + cfg.maxAge ∧ (0 < n → m = n)) := by
  obtain ⟨f, rest, t0, h1, h2, _, h4, _⟩ := send_ok htr hg
  refine ⟨f, rest, t0, h1, h2, fun x hx ha => mem_redisStops hx ha, ?_⟩
  intro a ha hap hrr
  obtain ⟨h, m, ph, th, L, e1, e2, e3, _, e5, e6⟩ := h4 a ha hap
  exact ⟨h, m, ph, th, L, e1, e2, e3, e5, (e6 hrr).1, (e6 hrr).2⟩

/-- No request starts with a send. -/
theorem a_trace_never_starts_with_a_send (cfg : Cfg) (r : Req) (w : World) (ticks : List Tick)
    {post : List Frame} {g : Frame} {n : Nat}
    (htr : (exec cfg r w ticks).trace = post ++ [g]) : g.act ≠ .send n := by
  intro hg
  obtain ⟨f, rest, _, h1, _⟩ := send_ok htr hg
  cases h1

/-! ## 2. No send after a stop -/

/-- THEOREM 2. If a send happened, then every read it rests on came back clear.
    For a Redis stop that read is the step right before the send. For an
    authority stop it is that stop's latest read. So a stop that a governing
    read would refuse on means that send is not in the trace.

    Expiry is one of the authority stops here: it is compared on every
    re-check. `expiry_has_no_window` says more for it than this theorem does. -/
theorem no_send_after_a_stop (cfg : Cfg) (r : Req) (w : World) (ticks : List Tick)
    {post : List Frame} {g : Frame} {older : List Frame} {n : Nat}
    (htr : (exec cfg r w ticks).trace = post ++ g :: older) (hg : g.act = .send n) :
    ∃ f rest t0, older = f :: rest ∧ f.act = .read n .atSend t0 (redisStops r) ∧
      (∀ x, x.isRedis = true → applies r x = true → refusesOn cfg f.w x = false) ∧
      (∀ a, a.isRedis = false → applies r a = true →
        ∃ h, lastRead a older = some h ∧ h.reads a = true ∧ refusesOn cfg h.w a = false) := by
  obtain ⟨f, rest, t0, h1, h2, h3, h4, _⟩ := send_ok htr hg
  refine ⟨f, rest, t0, h1, h2, fun x hx ha => h3 x (mem_redisStops hx ha), ?_⟩
  intro a ha hap
  obtain ⟨h, m, ph, th, L, e1, e2, e3, e4, _, _⟩ := h4 a ha hap
  exact ⟨h, e1, by simp [Frame.reads, e2, e3], e4⟩

/-- POSTURE, kill switch (platform, tenant, denylist, per-service). -/
theorem posture_kill_switch (cfg : Cfg) (w : World) (x : Stop) (hx : x.source = some .kill) :
    refusesOn cfg w x = if w.broken .kill = true then cfg.killClosed else w.armed x := by
  simp [refusesOn, hx]

/-- POSTURE, suspend and session: the same variable as the kill switch. -/
theorem posture_suspend (cfg : Cfg) (w : World) (x : Stop) (hx : x.source = some .suspend) :
    refusesOn cfg w x = if w.broken .suspend = true then cfg.killClosed else w.armed x := by
  simp [refusesOn, hx]

/-- POSTURE, delegation, mission, Direct Agent Key: an unreadable store refuses,
    whatever KILL_SWITCH_FAIL_CLOSED says. -/
theorem posture_authority (cfg : Cfg) (w : World) (a : Stop) (src : Source)
    (hs : a.source = some src) (ha : a.isRedis = false) :
    refusesOn cfg w a = (w.broken src || w.armed a) := by
  cases a <;> simp [Stop.isRedis] at ha <;> simp [Stop.source] at hs <;> (subst hs; rfl)

/-- POSTURE, expiry: nothing to be unreadable. -/
theorem posture_expiry (cfg : Cfg) (w : World) : refusesOn cfg w .expiry = w.armed .expiry := rfl

/-- The kill switch part of `refusesOn` is the read that Model.lean models and
    Theorems.lean proves the posture of: `isBlocked (readKillState env ...)`. -/
theorem kill_posture_is_the_proved_one (env : Env) (w : World) (agentId : String) :
    (refusesOn (codeOf env) w .platform || refusesOn (codeOf env) w .tenant ||
        refusesOn (codeOf env) w .denylist) =
      isBlocked
        (readKillState env
          (if w.broken .kill = true then .redisFailed
           else .loaded
             { platform := w.armed .platform, tenant := w.armed .tenant,
               denylist := if w.armed .denylist = true then [agentId] else [] }))
        agentId := by
  cases hb : w.broken .kill <;> cases hk : env.killClosed <;>
    cases h1 : w.armed .platform <;> cases h2 : w.armed .tenant <;>
    cases h3 : w.armed .denylist <;>
    simp [refusesOn, Stop.source, codeOf, code, readKillState, isBlocked, RedisKill.state, *]

/-- THEOREM 2, FAIL-CLOSED. With KILL_SWITCH_FAIL_CLOSED set, a send means the
    Redis read right before it SUCCEEDED and found no Redis stop in force. -/
theorem fail_closed_send_means_clear_redis_read (cfg : Cfg) (r : Req) (w : World)
    (ticks : List Tick) (hk : cfg.killClosed = true) {post : List Frame} {g : Frame}
    {older : List Frame} {n : Nat}
    (htr : (exec cfg r w ticks).trace = post ++ g :: older) (hg : g.act = .send n) :
    ∃ f rest, older = f :: rest ∧
      ∀ x, x.isRedis = true → applies r x = true →
        f.w.armed x = false ∧ ∀ src, x.source = some src → f.w.broken src = false := by
  obtain ⟨f, rest, _, h1, _, h3, _⟩ := no_send_after_a_stop cfg r w ticks htr hg
  refine ⟨f, rest, h1, ?_⟩
  intro x hx ha
  have h := h3 x hx ha
  cases x <;> simp_all [refusesOn, Stop.source, Stop.isRedis] <;>
    (split at h <;> simp_all)

/-- THEOREM 2, FAIL-OPEN (the code default). A send can follow a Redis stop that
    was in force at the last read in exactly one case: that stop's store could
    not be read. -/
theorem fail_open_send_despite_stop_means_unreadable (cfg : Cfg) (r : Req) (w : World)
    (ticks : List Tick) {post : List Frame} {g : Frame} {older : List Frame} {n : Nat}
    (htr : (exec cfg r w ticks).trace = post ++ g :: older) (hg : g.act = .send n) :
    ∃ f rest, older = f :: rest ∧
      ∀ x, x.isRedis = true → applies r x = true → f.w.armed x = true →
        cfg.killClosed = false ∧ ∃ src, x.source = some src ∧ f.w.broken src = true := by
  obtain ⟨f, rest, _, h1, _, h3, _⟩ := no_send_after_a_stop cfg r w ticks htr hg
  refine ⟨f, rest, h1, ?_⟩
  intro x hx ha harm
  have h := h3 x hx ha
  cases x <;> simp_all [refusesOn, Stop.source, Stop.isRedis] <;>
    (split at h <;> simp_all)

/-- THEOREM 2, AUTHORITY. Under BOTH settings of KILL_SWITCH_FAIL_CLOSED, a send
    means the latest read of each applicable authority succeeded and found it
    in order. A Direct Agent Key, a mission or a delegation that cannot be read
    is never sent on. -/
theorem authority_stop_blocks_send_under_both_postures (cfg : Cfg) (r : Req) (w : World)
    (ticks : List Tick) {post : List Frame} {g : Frame} {older : List Frame} {n : Nat}
    (htr : (exec cfg r w ticks).trace = post ++ g :: older) (hg : g.act = .send n)
    (a : Stop) (ha : a.isRedis = false) (hap : applies r a = true) :
    ∃ h, lastRead a older = some h ∧ h.reads a = true ∧ h.w.armed a = false ∧
      ∀ src, a.source = some src → h.w.broken src = false := by
  obtain ⟨_, _, _, _, _, _, h4⟩ := no_send_after_a_stop cfg r w ticks htr hg
  obtain ⟨h, e1, e2, e3⟩ := h4 a ha hap
  refine ⟨h, e1, e2, ?_⟩
  cases a <;> simp_all [refusesOn, Stop.source, Stop.isRedis]

/-! ## 3. The two-second rule -/

/-- THEOREM 3. THE ONLY WAYS a send can go out while a stop the re-check reads
    is in force at the last read:

    (a) a Redis stop whose store was unreadable, under fail-open; or
    (b) an authority stop (delegation, mission, Direct Agent Key) that was NOT
        yet in force at its own latest read, so it landed after that read; and
        that read belongs to a check that began at most `maxAge` (2 s) before
        the check at the send began. On a failover (`0 < n`) that read is
        inside the failover attempt.

    There is no third case. In particular no stop that was in force at its own
    latest read is ever sent on, and no authority read older than `maxAge`,
    measured to the start of the last check, backs a send.

    Expiry falls under (b) only in the narrowest sense: its latest read is
    always inside the last check itself (`expiry_has_no_window`), so the 2 s
    play no part for it. -/
theorem the_only_windows (cfg : Cfg) (r : Req) (w : World) (ticks : List Tick)
    {post : List Frame} {g : Frame} {older : List Frame} {n : Nat}
    (htr : (exec cfg r w ticks).trace = post ++ g :: older) (hg : g.act = .send n)
    (x : Stop) (hap : applies r x = true) (hrr : rereads cfg x = true) :
    ∃ f rest t0, older = f :: rest ∧ f.act = .read n .atSend t0 (redisStops r) ∧
      (f.w.armed x = true →
        (x.isRedis = true ∧ cfg.killClosed = false ∧
            ∃ src, x.source = some src ∧ f.w.broken src = true) ∨
        (x.isRedis = false ∧
            ∃ h m ph th L, lastRead x older = some h ∧ h.act = .read m ph th L ∧
              h.w.armed x = false ∧ th ≤ h.w.now ∧ t0 ≤ th + cfg.maxAge ∧ (0 < n → m = n))) := by
  obtain ⟨f, rest, t0, h1, h2, h3, h4, _⟩ := send_ok htr hg
  refine ⟨f, rest, t0, h1, h2, ?_⟩
  intro harm
  cases hx : x.isRedis with
  | true =>
    left
    have h := h3 x (mem_redisStops hx hap)
    refine ⟨rfl, ?_⟩
    cases x <;> simp_all [refusesOn, Stop.source, Stop.isRedis] <;>
      (split at h <;> simp_all)
  | false =>
    right
    obtain ⟨h, m, ph, th, L, e1, e2, _, e4, e5, e6⟩ := h4 x hx hap
    refine ⟨rfl, h, m, ph, th, L, e1, e2, ?_, e5, (e6 hrr).1, (e6 hrr).2⟩
    cases x <;> simp_all [refusesOn, Stop.source, Stop.isRedis]

/-! ### Example runs

The examples below say WHERE the request is when something lands, not how many
steps in: "while the failover's key is resolved" is `(.key 1, ...)`. Each one
is a real run of the model (`a_played_request_is_a_run`), so every theorem above
applies to it.
-/

def calm : World := { now := 0, armed := fun _ => false, broken := fun _ => false }
def quiet : Tick := { events := [], ok := true }
/-- These events land just before the step. -/
def landing (es : List Event) : Tick := { events := es, ok := true }
/-- The upstream answers with an error that asks for a failover, as `es` land. -/
def failing (es : List Event) : Tick := { events := es, ok := false }

/-- What the environment does, by where the request is. Quiet everywhere else. -/
def plan (l : List (Pc × Tick)) (pc : Pc) : Tick :=
  match l.find? (fun e => e.1 == pc) with
  | some e => e.2
  | none => quiet

def play (cfg : Cfg) (r : Req) (pl : Pc → Tick) : Nat → St → St
  | 0, s => s
  | k + 1, s => play cfg r pl k (step cfg r (pl s.pc) s)

/-- A request played from a calm world for 48 steps, more than any example needs:
    a finished request does not move. -/
def request (cfg : Cfg) (r : Req) (l : List (Pc × Tick)) : St := play cfg r (plan l) 48 (init calm)

theorem exec_snoc (cfg : Cfg) (r : Req) (w : World) (ticks : List Tick) (t : Tick) :
    exec cfg r w (ticks ++ [t]) = step cfg r t (exec cfg r w ticks) := by
  simp [exec, List.foldl_append]

theorem play_is_a_run (cfg : Cfg) (r : Req) (w : World) (pl : Pc → Tick) :
    ∀ (k : Nat) (ticks : List Tick),
      ∃ ticks', play cfg r pl k (exec cfg r w ticks) = exec cfg r w ticks'
  | 0, ticks => ⟨ticks, rfl⟩
  | k + 1, ticks => by
    obtain ⟨t', h⟩ := play_is_a_run cfg r w pl k (ticks ++ [pl (exec cfg r w ticks).pc])
    exact ⟨t', by rw [← h, exec_snoc]; rfl⟩

/-- Every example below is one of the runs the headline theorems quantify over. -/
theorem a_played_request_is_a_run (cfg : Cfg) (r : Req) (l : List (Pc × Tick)) :
    ∃ ticks, request cfg r l = exec cfg r calm ticks :=
  play_is_a_run cfg r calm (plan l) 48 []

/-- The key resolutions and the sends, oldest first. -/
def keysAndSends (s : St) : List Action :=
  (acts s).filter (fun a => match a with | .key _ => true | .send _ => true | _ => false)

/-- The last `k` steps, oldest first. -/
def ending (k : Nat) (s : St) : List Action := ((s.trace.take k).map (fun f => f.act)).reverse

def worker (fallbacks : Nat) : Req :=
  { route := .llm, door := .passport, delegated := true, asks := false, fallbacks := fallbacks }
def plain (fallbacks : Nat) : Req :=
  { route := .llm, door := .passport, delegated := false, asks := false, fallbacks := fallbacks }
def keyHolder (fallbacks : Nat) : Req :=
  { route := .llm, door := .directKey, delegated := false, asks := false, fallbacks := fallbacks }
def serviceAsk : Req :=
  { route := .service, door := .passport, delegated := false, asks := true, fallbacks := 0 }

/-! ### The windows are real -/

/-- WINDOW, FIRST ATTEMPT (left open by the 2 s rule, on purpose). A delegation
    is revoked 100 ms after admission, during a fast upload. The re-checks do
    not read it again, and the first attempt is sent. -/
theorem window_fast_first_attempt_is_open :
    sent (request (code true) (worker 0) [(.body, landing [.elapse 100, .arm .delegation])])
      = [0] := by
  decide

/-- The same revoke after a slow upload (2001 ms): read again, refused, no key
    resolved, nothing sent, the hold released. -/
theorem slow_first_attempt_is_reread :
    let s := request (code true) (worker 0) [(.body, landing [.elapse 2001, .arm .delegation])]
    keysAndSends s = [] ∧ ending 2 s = [.release 0, .refuse 0 .beforeKey] := by
  decide

/-- WINDOW, FAILOVER (NOT closed by the fix). The primary fails. The failover's
    forced read sees the delegation in order. The delegation is then revoked
    while the failover's key is resolved. The check at the send does not force
    the authority reads, less than 2 s have passed, and the failover is sent.

    So "a failover attempt has no window" is FALSE of the code. What is true is
    `the_only_windows`: the window of a failover lies inside the attempt,
    between its forced read and its send. If the check at the send forced the
    authority reads on a failover, this theorem would stop compiling. -/
theorem failover_window_is_open_between_its_read_and_its_send :
    sent (request (code true) (worker 1)
      [(.send 0, failing []), (.key 1, landing [.arm .delegation])]) = [0, 1] := by
  decide

/-- The same holds for a mission and for a Direct Agent Key. -/
theorem failover_window_is_open_for_mission_and_direct_key :
    sent (request (code true) (plain 1)
        [(.send 0, failing []), (.key 1, landing [.arm .mission])]) = [0, 1] ∧
      sent (request (code true) (keyHolder 1)
        [(.send 0, failing []), (.permit 1, landing [.arm .directKey])]) = [0, 1] := by
  decide

/-- The same revoke when resolving the failover's key took 2001 ms: read again
    at the send, refused, the failover is not sent and its hold is settled at
    zero. -/
theorem slow_failover_is_reread :
    let s := request (code true) (worker 1)
      [(.send 0, failing []), (.key 1, landing [.elapse 2001, .arm .delegation])]
    sent s = [0] ∧ ending 2 s = [.settleZero 1, .refuse 1 .atSend] := by
  decide

/-- A Redis stop has no such window on a failover: armed while the failover's
    dispatch permission is taken, it is read at the send and the failover is
    not sent. -/
theorem redis_stop_has_no_failover_window :
    sent (request (code false) (worker 1)
      [(.send 0, failing []), (.permit 1, landing [.arm .tenant])]) = [0] := by
  decide

/-- THE 2 s ARE MEASURED TO THE START OF THE LAST CHECK, NOT TO THE SEND. A
    Direct Agent Key is re-read before the key (at 2100 ms). The check at the
    send starts 1950 ms later, so the key is not read again; the mission is, and
    that read is slow (10 s). The key is revoked meanwhile. The call is sent on
    a key read that is by then 11.95 s old. `the_only_windows` allows exactly
    this: its bound is on when the last check BEGAN. -/
theorem the_window_is_measured_to_the_start_of_the_last_check :
    sent (request (code true) (keyHolder 0)
      [(.check 0 .admission 0 [.mission], landing [.elapse 500]),
       (.body, landing [.elapse 1600]),
       (.key 0, landing [.elapse 1950]),
       (.check 0 .atSend 4050 [], landing [.elapse 10000, .arm .directKey])]) = [0] := by
  decide

/-! ### Expiry: gap B5-05, closed by commit 944adc4

Audit B5 found that a visa or delegation link could expire during a slow upload
and still get a hold and a send. Until that commit this file proved the gap as a
counterexample. The code now compares expiry on every re-check and before a
delegated visa's hold, and what was the counterexample is the theorems below.
-/

/-- EXPIRY HAS NO 2-SECOND WINDOW. Before every send, first attempt or failover,
    expiry was compared by that attempt's own check at the send, the very check
    whose Redis read is the step right before the send, and it had not passed.
    Unlike a delegation, a mission or a Direct Agent Key, an expiry comparison
    is never reused from an earlier check. -/
theorem expiry_has_no_window (cfg : Cfg) (r : Req) (w : World) (ticks : List Tick)
    (hrr : cfg.rereadsExpiry = true) (hap : applies r .expiry = true)
    {post : List Frame} {g : Frame} {older : List Frame} {n : Nat}
    (htr : (exec cfg r w ticks).trace = post ++ g :: older) (hg : g.act = .send n) :
    ∃ f rest t0 h, older = f :: rest ∧ f.act = .read n .atSend t0 (redisStops r) ∧
      lastRead .expiry older = some h ∧ h.act = .read n .atSend t0 [.expiry] ∧
      h.w.armed .expiry = false := by
  obtain ⟨f, rest, t0, h1, h2, _, h4, h5⟩ := send_ok htr hg
  obtain ⟨h, hl, ha⟩ := h5 (by simp [rereads, hrr]) hap
  obtain ⟨h', _, _, _, _, e1, _, _, e4, _⟩ := h4 .expiry rfl hap
  have he : h' = h := Option.some.inj (e1.symm.trans hl)
  subst he
  exact ⟨f, rest, t0, h', h1, h2, hl, ha, e4⟩

/-- The code re-reads every stop. Nothing is left out of theorems 1 to 3. -/
theorem the_code_rereads_every_stop (killClosed : Bool) (x : Stop) :
    rereads (code killClosed) x = true := by
  cases x <;> rfl

/-- B5-05, CLOSED, a delegated visa. It expires during a slow upload (3 s). The
    check before the hold sees it: no hold is opened, no key is resolved,
    nothing is sent. The last three steps are the admission read, the upload,
    and the refusal. -/
theorem B5_05_expiry_during_upload_opens_no_hold :
    let s := request (code true) (worker 0) [(.body, landing [.elapse 3000, .arm .expiry])]
    keysAndSends s = [] ∧
      ending 3 s = [.read 0 .admission 0 [.platform, .tenant, .denylist, .session, .suspend],
        .body, .refuse 0 .beforeHold] := by
  decide

/-- B5-05, CLOSED, an ordinary visa. The hold is opened (the check before the
    hold is for delegated visas), the re-check before the key compares expiry,
    and the hold is released. No key, no send. -/
theorem B5_05_expiry_during_upload_ordinary_visa_releases_its_hold :
    let s := request (code true) (plain 0) [(.body, landing [.elapse 3000, .arm .expiry])]
    keysAndSends s = [] ∧
      ending 3 s = [.read 0 .beforeKey 3000 [.expiry], .release 0, .refuse 0 .beforeKey] := by
  decide

/-- No 2-second rule for expiry: 100 ms after admission, on a fast call, it is
    still refused. The same timing for a revoked delegation is sent
    (`window_fast_first_attempt_is_open`). -/
theorem expiry_shortly_after_admission_is_refused :
    sent (request (code true) (plain 0) [(.body, landing [.elapse 100, .arm .expiry])]) = [] := by
  decide

/-- And none on a failover: a visa that expires while the failover's key is
    resolved is caught at the send, and the hold is settled at zero. The same
    timing for a revoked delegation is sent
    (`failover_window_is_open_between_its_read_and_its_send`). -/
theorem expiry_has_no_failover_window :
    let s := request (code true) (plain 1)
      [(.send 0, failing []), (.key 1, landing [.arm .expiry])]
    sent s = [0] ∧ ending 2 s = [.settleZero 1, .refuse 1 .atSend] := by
  decide

/-- A visa that expires as the primary fails stops the failover before a second
    hold: the qualification check compares expiry too. -/
theorem expiry_stops_the_failover_at_qualification :
    let s := request (code true) (plain 1) [(.send 0, failing [.arm .expiry])]
    sent s = [0] ∧ ending 2 s = [.stopFailover 1, .respond] := by
  decide

/-- THE GAP AS IT WAS. With a re-check that does not compare expiry, which is
    the code before commit 944adc4, the same slow upload is sent. This is the
    theorem that used to be stated of `code`. -/
theorem B5_05_was_open_before_the_fix :
    sent (request { code true with rereadsExpiry := false } (worker 0)
      [(.body, landing [.elapse 3000, .arm .expiry])]) = [0] := by
  decide

/-- Expiry is the only stop a configuration can leave out of the re-check.
    Theorems 1 to 3 are stated over `rereads`, and `the_code_rereads_every_stop`
    says the code leaves nothing out. -/
theorem only_expiry_can_be_left_out (cfg : Cfg) (x : Stop) (h : rereads cfg x = false) :
    x = .expiry := by
  cases x <;> simp_all [rereads]

/-! ## 4. A refusal after the hold releases it -/

/-- THEOREM 4. A refusal is the LAST step of its trace: nothing follows it, so
    no key is resolved and nothing is sent after it. When the refusal comes
    from a re-check on the LLM route (before the key, or at the send), the step
    right before it closes that attempt's hold: released as not dispatched, or
    settled at zero when the dispatch permission was already taken. And that
    hold was opened earlier in the trace. -/
theorem refusal_after_hold_closes_it (cfg : Cfg) (r : Req) (w : World) (ticks : List Tick)
    {post : List Frame} {g : Frame} {older : List Frame} {n : Nat} {ph : Phase}
    (htr : (exec cfg r w ticks).trace = post ++ g :: older) (hg : g.act = .refuse n ph) :
    post = [] ∧ (exec cfg r w ticks).pc = .done ∧
      ((ph = .beforeKey ∨ ph = .atSend) → r.route = .llm →
        ∃ f rest, older = f :: rest ∧ (f.act = .release n ∨ f.act = .settleZero n) ∧
          ∃ h ∈ rest, h.act = .hold n) := by
  have hi := exec_inv cfg r w ticks
  by_cases hd : (exec cfg r w ticks).pc = .done
  · have hf := hi.ended hd
    rw [htr] at hf
    cases post with
    | nil =>
      simp only [List.nil_append, Final] at hf
      exact ⟨rfl, hd, fun h1 h2 => hf.2 n ph hg h1 h2⟩
    | cons p ps =>
      simp only [List.cons_append, Final] at hf
      exact absurd hg (hf.1 g (by simp) n ph)
  · have hno := hi.running hd
    rw [htr] at hno
    exact absurd hg (hno g (by simp) n ph)

/-- A read that refuses goes to the refusal, whatever else is true. -/
theorem refused_read_goes_to_refusal (cfg : Cfg) (r : Req) (t : Tick) (s : St) (n : Nat)
    (ph : Phase) (t0 : Nat) (todo : List Stop)
    (h : match todo with
      | a :: _ => refusesOn cfg (s.w.after t.events) a = true
      | [] => (redisStops r).any (refusesOn cfg (s.w.after t.events)) = true) :
    (stepCheck cfg r t s n ph t0 todo).pc = refusalPc r n ph := by
  cases todo with
  | cons a rest => simp only at h; simp [stepCheck, h, St.push]
  | nil => simp only at h; simp [stepCheck, h, St.push]

/-- And a re-check refusal on the LLM route reaches its end in two more steps:
    the hold is closed, then the refusal is returned. -/
theorem recheck_refusal_finishes (cfg : Cfg) (r : Req) (s : St) (n : Nat) (ph : Phase)
    (hph : ph = .beforeKey ∨ ph = .atSend) (hpc : s.pc = .closing n ph) (t1 t2 : Tick) :
    (step cfg r t2 (step cfg r t1 s)).pc = .done ∧
      ∃ f1 f2, (step cfg r t2 (step cfg r t1 s)).trace = f2 :: f1 :: s.trace ∧
        (f1.act = .release n ∨ f1.act = .settleZero n) ∧ f2.act = .refuse n ph := by
  rcases hph with h | h <;> subst h
  · exact ⟨by simp [step, stepAt, hpc, St.push],
      ⟨t1.events, s.w.after t1.events, .release n⟩,
      ⟨t2.events, (s.w.after t1.events).after t2.events, .refuse n .beforeKey⟩,
      by simp [step, stepAt, hpc, St.push], Or.inl rfl, rfl⟩
  · exact ⟨by simp [step, stepAt, hpc, St.push],
      ⟨t1.events, s.w.after t1.events, .settleZero n⟩,
      ⟨t2.events, (s.w.after t1.events).after t2.events, .refuse n .atSend⟩,
      by simp [step, stepAt, hpc, St.push], Or.inr rfl, rfl⟩

/-! ## The four escapes of audit B2, as runs

Each is a run of the fixed model that ends without the escaping send. Removing
a re-check from `stepAt` makes these stop compiling.
-/

/-- B2-01. A tenant stop lands during a slow upload. No key is resolved, nothing
    is sent, and the hold that was opened is released. -/
theorem B2_01_tenant_stop_during_slow_upload :
    let s := request (code false) (plain 0) [(.body, landing [.elapse 30000, .arm .tenant])]
    keysAndSends s = [] ∧ ending 2 s = [.release 0, .refuse 0 .beforeKey] := by
  decide

/-- B2-02. A service stop lands during the approval wait. No token is resolved
    and nothing is sent. -/
theorem B2_02_service_stop_during_approval_wait :
    let s := request (code false) serviceAsk [(.approval, landing [.elapse 60000, .arm .service])]
    keysAndSends s = [] ∧ ending 1 s = [.refuse 0 .beforeKey] := by
  decide

/-- B2-03. A delegation is revoked as the primary fails. The failover's forced
    read sees it; no second key is resolved, the failover is not sent, and its
    hold is released. -/
theorem B2_03_delegation_revoked_before_failover :
    let s := request (code false) (worker 1) [(.send 0, failing [.arm .delegation])]
    keysAndSends s = [.key 0, .send 0] ∧ ending 2 s = [.release 1, .refuse 1 .beforeKey] := by
  decide

/-- B2-04. A mission ends as the primary fails. The failover is not sent. -/
theorem B2_04_mission_ended_before_failover :
    let s := request (code false) (plain 1) [(.send 0, failing [.arm .mission])]
    keysAndSends s = [.key 0, .send 0] ∧ ending 2 s = [.release 1, .refuse 1 .beforeKey] := by
  decide

/-- B2-05. A Direct Agent Key is revoked as the primary fails. The failover is
    not sent. -/
theorem B2_05_direct_key_revoked_before_failover :
    let s := request (code false) (keyHolder 1) [(.send 0, failing [.arm .directKey])]
    keysAndSends s = [.key 0, .send 0] ∧ ending 2 s = [.release 1, .refuse 1 .beforeKey] := by
  decide

/-- A stop that lands while the dispatch permission is taken is caught by the
    check at the send: the key was resolved, nothing is sent, and the hold is
    settled at zero. -/
theorem stop_during_permission_is_caught_at_the_send :
    let s := request (code false) (plain 0) [(.permit 0, landing [.arm .platform])]
    keysAndSends s = [.key 0] ∧ ending 2 s = [.settleZero 0, .refuse 0 .atSend] := by
  decide

/-- With nothing armed, one attempt is sent; with a failing primary and one
    candidate, two are. The model does not refuse everything. -/
theorem quiet_requests_are_sent :
    sent (request (code true) (worker 0) []) = [0] ∧
      sent (request (code true) (worker 1) [(.send 0, failing [])]) = [0, 1] ∧
      sent (request (code true) serviceAsk []) = [0] := by
  decide

/-! ### Posture, as runs -/

/-- The kill switch becomes unreadable with a tenant stop in force, while the
    dispatch permission is taken. FAIL-OPEN, the code default: the call is sent. -/
theorem unreadable_kill_switch_fail_open_sends :
    sent (request (code false) (plain 0) [(.permit 0, landing [.break .kill, .arm .tenant])])
      = [0] := by
  decide

/-- The same run, FAIL-CLOSED: nothing is sent. -/
theorem unreadable_kill_switch_fail_closed_refuses :
    sent (request (code true) (plain 0) [(.permit 0, landing [.break .kill, .arm .tenant])])
      = [] := by
  decide

/-- The Direct Agent Key cannot be re-read after a slow upload: nothing is sent,
    under either setting. -/
theorem unreadable_direct_key_refuses_under_both (killClosed : Bool) :
    sent (request (code killClosed) (keyHolder 0)
      [(.body, landing [.elapse 5000, .break .directKey])]) = [] := by
  cases killClosed <;> decide


end Stops.Dispatch
