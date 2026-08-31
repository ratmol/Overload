# DECISIONS.md

ADR-lite. One entry per irreversible or expensive-to-reverse call. Newest last.
If you are about to argue with past-you, the argument is probably here already.

---

## 1. MIT licence, fork nothing

OpenNutriTracker is GPL-3.0 and wger is AGPL-3.0. Forking either makes this
derivative GPL/AGPL permanently — a constraint chosen on day one to save time
that would not actually be saved, since it would mean learning Dart to modify
someone else's app.

Reading their architecture for ideas costs nothing and carries no obligation.

**Reversible?** Practically, no. Changing licence later requires consent from
every contributor.

---

## 2. TypeScript monorepo, two workspaces, no backend

`packages/engine` (the portfolio piece) and `apps/web` (the tool). Not nine
packages. `docs/` has two files, not six.

No server, no accounts, no sync, no analytics, no telemetry. If a task appears
to need one, the task is wrong. Storage is IndexedDB via Dexie; the PWA installs
to a home screen and works offline because there is nothing to be offline from.

---

## 3. Zod lives in the engine, despite "zero-dependency"

The spec's stack table says the engine is a zero-dependency package, and the
repo layout says `types.ts` holds "Zod schemas, single source of truth". Those
two statements contradict each other.

**Chosen: Zod, one dependency.** Hand-written type guards duplicated against
hand-written TS types is exactly the drift the single-source-of-truth rule
exists to prevent, and the drift lands in the persistence layer where it is
hardest to detect. One well-audited dependency is cheaper than that.

**Cost:** the engine is not literally zero-dep, so the README should say
"one runtime dependency" rather than claiming otherwise.

**Reversible?** Yes, at moderate cost — the schemas are all in one file.

---

## 4. Dates are ISO calendar strings, not timestamps

Every domain rule here is day-grained: bodyweight *on a date*, sets *this week*,
one adjustment *per 7 days*. Storing `Date` objects or epoch millis invites
timezone bugs where a 11pm gym session lands on tomorrow's volume audit.

`SetLog.timestamp` is the one exception, because within-session set ordering
genuinely needs sub-day resolution.

All date arithmetic goes through `dates.ts` and is UTC-only.

---

## 5. Nothing derived is stored

`systemLoad`, daily intake totals, weekly volume, and trend values are all
computed at read time. Storing them is how data drifts out of sync: a corrected
bodyweight entry must retroactively change every system load that depended on
it, and it cannot do that if the number was written down.

**Cost:** more computation per render. At the data volumes involved (a few
thousand sets per year) this is not measurable.

---

## 6. Outlier detection: residuals against the trend, 4 MAD

Superseded two earlier calibrations, both of which produced unacceptable false
positives (12%, then 5%). Full reasoning in `ALGORITHM.md` §2.1.

The asymmetry that drives the choice: a missed outlier costs one slightly-wrong
trend point, whereas a false flag halves the weight of a *legitimate* reading.
An over-eager detector produces a trend that ignores real movement.

**Reversible?** Yes, it is three constants. But do not change them without
re-running the 25-seed tests in `trend.test.ts`.

---

## 7. The warm-up bias is disclosed, not corrected — at EIGHT half-lives

The EWMA slope is biased toward zero for the first ~8 weeks (see ALGORITHM.md
§1.1). Bias-correcting a hand-seeded EWMA introduces its own artefacts, and the
correction would be least trustworthy exactly when it matters most.

**Chosen:** expose `warmingUp`, cap confidence at `low`, and hard-block in
`adjustTarget`. The engine says "I do not know yet" rather than guessing.

**Corrected after review.** The gate was originally four half-lives (28 days),
chosen because four is the conventional settling point. Measurement showed the
bias is 31% at exactly 28 days and only falls under 5% around 56 — so the gate
released at the point of maximum bias. Now eight half-lives, and pinned by a
test that measures the bias curve so the doc table cannot drift from the code.

**Also corrected:** "let the existing guardrails prevent action" was false. No
such guardrail existed in `adjust.ts`, in any version, while this document, the
package README and CLAUDE.md all asserted it did. There was no test for it,
which is why it survived. Documentation is not a guardrail.

This matters more than it sounds: an understated gain rate reads as "not gaining
fast enough", and the naive response is to add calories. During month one that is
precisely backwards.

---

## 8. energyDensityPerLb = 2500 on a gain — right value, wrong reasoning

The value stands. The justification originally recorded here was wrong, with the
sign inverted twice, and is preserved as a correction rather than deleted.

**What it said:** overestimating density makes the engine under-correct, because
it attributes a weight change to fewer calories than really caused it.

**Why that is backwards:** overestimating density attributes a weight change to
*more* calories. And in `adjust.ts` the delta is `rateError x density / 7`, so a
larger density produces a *larger* correction — 2500 over-corrects relative to
1850 by 35%. The original reasoning was about the TDEE path, where the
sensitivity runs the other way, applied to the adjustment path.

**What actually justifies 2500:** the 1850 figure came from optimistic inputs —
60/40 partitioning (a ceiling for a trained lifter, not a central estimate) and
750 kcal/lb for lean tissue (its *stored* energy, ignoring the metabolic cost of
depositing it). With 45/55 partitioning and ~1150 kcal/lb deposition cost, the
arithmetic gives 2497. 2500 is what honest inputs produce.

The conservatism that used to hide inside this constant now lives where it can
be seen, as an explicit `damping` factor in `adjust.ts`.

**Revisit when** there are 12+ weeks of real data plus a second DEXA scan, at
which point the actual personal accrual ratio is measurable and the constant can
be fitted rather than assumed.

---

## 9. Hard sets are RIR ≤ 4, secondary muscles count 0.5

Both thresholds are judgement calls that materially change the volume audit.

RIR ≤ 4 because a set left 5+ reps short does not drive meaningful hypertrophy,
and counting it makes the audit unable to distinguish a hard week from a lazy
one.

0.5 for secondaries because the training plan deliberately runs near-zero
*direct* arm volume, on the theory that heavy pulling and dipping covers it. If
secondaries counted zero, the audit would scream "biceps under-target" every
week and get ignored. If they counted 1.0, it would report adequate arm volume
from rows alone and never flag a real gap.

**Reversible?** Yes — the fractions are data in `plan.json`, not code.

---

## 10. Naming: `overload`

Package scope `@overload/engine`. Ties to progressive overload and to system
load, which is the headline feature. Picked before the first commit, on the
grounds that it is cheap now and annoying later.

---

## 11. Adjustment is gated on a rate BAND, damped, and floored

Superseded the original scalar-target design. Three changes, one cause: this is
a controller with a 2-3 week lag, and the first version adjusted weekly into
that lag with a deadband of 0.035 lb/week.

- **Band, not point.** The plan says 0.25-0.5 lb/week. Inside it, do nothing.
- **Damping at 0.6.** Only part of the computed correction is applied, so the
  controller stops stacking corrections for changes it cannot see yet.
- **14 days between adjustments**, up from 7. Two EWMA half-lives.
- **A 1600 kcal floor**, plus a rule that a gain-phase target may not drop below
  the low end of its own estimated expenditure.

The concrete failure this prevents: starting creatine and raising carbs adds 2-4
lb of water and glycogen over a fortnight, reads as ~1 lb/week of gain, and
invites repeated cuts for something that was never tissue. At 100 kcal/week with
no floor, a 2550 target reaches RMR in under three months.

**Reversible?** Yes, all constants. But `targetRatePerWeekLb` became
`targetRateBandLbPerWeek`, which is a schema change.

---

## 12. estimateTaggedExpenditure was deleted, not fixed

It reported shift-day and off-day *expenditure* derived from the intake
difference. The output was algebraically identical to its input, never touched
the weight trend, and therefore contained no evidence about expenditure at all.
Clamping to [0, 600] also censored the disconfirming direction, so a user eating
*less* on shift days was told there was no difference.

Replaced by `summariseTaggedIntake`, which reports the signed difference, a
Welch interval, and whether it clears its own noise floor. The question it used
to pretend to answer needs step count as a direct input.

**Reversible?** The name and shape changed, so callers break loudly. That is the
intent — a silent signature-compatible fix would have left the same wrong idea
in place.

---

## 13. The engine can escalate beyond calories

`needs-review` blocks adjustment and points at a blood panel when good data has
failed to move for several cycles and cumulative drift exceeds 300 kcal.

Before this, the only vocabulary for a flat trend was "add 100 more", forever. A
verified surplus with no response is close to the textbook presentation of the
causes the training plan lists as highest priority to rule out. An engine that
absorbs that into weekly increments is actively delaying a diagnosis.

**Reversible?** Yes.

---

## 14. The Dexie schema mirrors the Zod types exactly, and stores bodyweight

Seven tables — `exercises`, `templates`, `sessions`, `sets`, `weights`,
`profile`, `plan` — each holding the engine's own type with no app-local
wrapper. The alternative was a persistence-shaped model with a mapping layer,
which is the standard advice and wrong here: there is one consumer, no network
boundary, and the mapping layer's only real product would be drift between two
descriptions of a set.

The indices are the decision worth writing down, because changing them later
means a migration:

- `sessions: [templateId+date]` — "when did I last do Upper A" without a scan.
- `sets: [exerciseId+sessionId]` — the hot path. The session screen asks for one
  exercise's sets in one session on every keystroke.
- `weights: &date` — **unique**. One weigh-in per calendar day, replaced rather
  than appended, so a second reading cannot quietly skew a day.

No derived column exists anywhere, per §5. There is no `systemLoad` field.

**Bodyweight in a Stage 1 app** is the part that looks like scope creep and is
not. System load is `bodyweight + belt`; without a weight the headline feature
prints `—` forever. What is deliberately absent is everything that comes *after*
a weight: no trend, no average, no rate, no calories. The engine owns that and
it is Stage 3.

**Also decided here:** the plan seeds the database once and is then additive
only. A `plan.json` version bump inserts new exercises and leaves existing rows
alone, because a rep range edited in the app is a decision and a deploy is not a
reason to reverse it.

**Reversible?** The index set, yes, at the cost of a Dexie version bump and a
migration. The mirror-the-engine-types choice, yes but expensively — it is the
shape of every read in the app.

---

## 15. The engine proposes; the user accepts. Nothing auto-applies

`adjustTarget` runs on every render of the dashboard, but its output is a
proposal with an Accept button, never a write. The alternatives were auto-apply
(what MacroFactor does) and a weekly prompt.

The reason is the product's one real claim: it explains every number before it
changes anything. A change applied while you slept cannot have been read first,
so auto-apply would quietly delete the feature the whole engine exists to
provide. It also makes the block states legible — "not confident enough,
because X" is shown with the same prominence as a proposal, because the engine
declining to act *is* the product working.

**Cost:** a proposal can sit unaccepted, so `currentTarget` may lag what the
engine thinks. Accepted: an ignored proposal is a valid answer, and the engine
re-makes the case whenever it has grounds to.

**Also decided here:**

- **Import replaces per-date, never appends.** Re-exporting the last 90 days
  every time is the normal case. Appending would double every day in the
  overlap, which doubles mean intake and moves estimated expenditure by roughly
  a thousand calories. Per-date replacement is the only version that is safe to
  run twice.
- **Cronometer's per-food rows are kept, not summed.** `estimateTdee` already
  aggregates to daily totals and documents that multiple rows per day are legal.
  Summing at import would discard detail and create a second implementation of
  the same arithmetic to disagree with.
- **Ambiguous dates are rejected, not guessed.** `03/04/2026` is March 4th to
  one exporter and April 3rd to another. Guessing shifts a month of intake onto
  the wrong days and the resulting TDEE still looks entirely reasonable, which
  is what makes it dangerous.
- **A manual target change resets the baseline.** The baseline exists to measure
  how far the *engine* has walked the number; counting a user's own decision as
  drift would push it toward the needs-review escalation for something nobody
  got wrong.

**Reversible?** Yes, all of it. The import rules are the expensive ones to
change after data exists.

---

## 16. Food logging is being built, reversing "probably never"

`overload-project-spec.md` §13 lists "a food database or barcode scanner" under
what not to build, at Stage 4 "at the earliest, probably never". The reasoning
was that Cronometer already does this well and rebuilding it is waste.

**That reasoning still holds for search over 300,000 foods. It does not hold for
a list of the forty things actually eaten**, which is a different and much
smaller product. The deciding fact is empirical: no intake is being logged at
all, so the adaptive engine — the entire portfolio piece — is inert. A tool that
gets used beats a better tool that does not.

Scope is a personal food list plus barcode lookup, seeded from USDA with live
lookup to add new foods. Not a searchable database of everything.

**What does not change:** no server; both APIs are called from the browser and
only when adding a food, never in the daily logging path. No network in
`packages/engine`. Nothing derived is stored — except one thing, below.

**Reversible?** The decision, yes. The data, no: once months of food rows exist,
removing the feature means abandoning them.

---

## 17. Logged food snapshots its macros — the one exception to §5

§5 says nothing derived is stored, and `FoodLogEntry` stores `kcal`,
`proteinG`, `carbsG` and `fatG` alongside the `foodId` and `grams` they could be
recomputed from. This is deliberate and it is the only exception in the schema.

The reason is that the alternative is retroactive rewriting of history. Correct
a food six weeks from now — the USDA entry turns out to be for raw chicken, not
cooked — and a derived-at-read-time design silently changes every day that food
appears in. Those days already fed calorie decisions the engine made, explained
in a written reason, and that the user accepted. **A log is a record of what was
believed at the time, not a view over current beliefs.**

The cost is real: correcting a food does not fix past days, so a
long-running error stays in the history. That is the right trade — a visible
wrong number in the past is recoverable, and a silently mutating past is not.

**Also decided here:**

- **Two tables, not one.** `foodLog` is one row per food, many per day, written
  incrementally. `intake` is one row per day or per imported line, and its
  manual-entry path deletes every row for a date before inserting. Sharing a
  table would mean logging breakfast and later opening manual entry destroys
  breakfast. `reconcileIntake` merges them at read time, food rows winning
  where they exist because they are the more specific record. Nothing is ever
  handed both tables concatenated — that double-counts every day in both.
- **`isFavourite` is not indexed**, contrary to the spec's proposed schema.
  IndexedDB keys may only be numbers, strings, Dates, ArrayBuffers or Arrays, so
  indexing a boolean silently indexes nothing and the query returns empty
  forever without erroring. A few dozen staples sort fine in memory.
- **An assumed shift/off tag is reported, not hidden.** Food rows carry no
  activity tag. Days where one had to be assumed still count toward the calorie
  estimate, which ignores the tag entirely, and are excluded from the shift/off
  comparison, which is *entirely* about the tag. Defaulting silently to `off`
  would fabricate the exact quantity being measured.

**Reversible?** The snapshot, no — past rows would have to be recomputed, which
is the thing it exists to prevent.

---

## 18. A plan version bump now overwrites existing exercises

§14 established that seeding is additive and never destructive: a `plan.json`
version bump inserts new exercises and leaves existing rows alone, "because a
rep range edited in the app is a decision and a deploy is not a reason to
reverse it."

**That rule made program v2 undeliverable.** v2 changes `defaultSets`,
`defaultRepRange`, `restSeconds` and the new RIR ladder on nearly every existing
exercise. Under additive-only seeding, bumping the version would have added the
incline barbell press and the band pull-apart while leaving squats, pull-ups and
everything else on v1's numbers — a plan that is half of each version and
matches no document.

The protection was also guarding something that does not exist. **There is no
in-app exercise editor.** No user edit can be destroyed by this, because there
is no way to make one. When an editor is built, this needs revisiting — most
likely a per-exercise "edited by hand" flag that the migration skips.

**Chosen:** on a version bump, `bulkPut` every exercise and template from
`plan.json`. Alternatives were a one-off migration script (same effect, more
ceremony, and it has to be written again for v3) and an in-app "reset to plan"
button (puts a destructive action behind a tap nobody would find at the moment
they needed it).

**What is never touched:** logged sets, sessions, weights, and exercises that
have left the plan. Cutting the deadlift removes it from every template but
keeps the exercise row, so months of logged deadlifts still resolve to a name
and it stays available as a substitute. Verified against a database seeded by
the previous release: a logged deadlift set survived the migration intact.

**Reversible?** The rule, yes. A migration that has already run, no — the old
values are gone. That is what the JSON export is for.

---

## 19. Per-set RIR targets and superset groups are schema, not notes

`Exercise` gains `targetRirBySet: number[]`, `supersetGroup?: string` and
`restSeconds?: number`.

The RIR ladder had to be per-SET rather than per-exercise, which is the whole
reason a new field was needed instead of reusing a note. Program v2's argument
is that *failure is earned by the exercise*: a cable lateral raise fails
locally and costs a sore delt, so it earns true failure on all four sets, while
a +70 dip fails systemically and bills the next 48 hours, so it stops at RIR 1
and only on the last set. `[2, 2, 1]` and `[0]` are both unrepresentable in a
single scalar.

Without this in the schema the app would prescribe v2's sets while losing the
reason they are survivable — and the sets alone, taken at the old effort, are
the thing that caused the fatigue v2 exists to fix.

**Ladders shorter than the set count repeat their last rung**, so `[2, 2, 1]`
on a fourth set gives 1 rather than `undefined`, and `[0]` means failure on
every set however many there are. Deload overrides the ladder entirely at RIR 4
— a deload still demanding failure on lateral raises would not be a deload.

**Reversible?** Yes. Both fields are optional and every v1 exercise without them
falls back to RIR 2.

---

## 20. Alternates are curated data, and a swap is per-session

`Exercise.alternates` lists stand-ins, best first. `Session.swaps` maps a
programmed exercise id to what was actually done, for that session only.

**Curated rather than computed.** A "same muscles" search over the library would
happily offer a lateral raise as a substitute for a pull-up. The alternates were
chosen to hold the week's volume: swapping a slot must not quietly halve a
priority muscle. The full library stays reachable by search, because a curated
list is still a guess about a gym nobody has seen.

**Per-session, not a template edit.** The commonest reason to swap is "the rack
was busy", which is a fact about today, so next week goes back to the programmed
lift with no action. The template is read *through* the swap map rather than
rewritten. A swap survives a reload because it lives on the session row.

**Unilateral variants count as one set, not two.** A single-leg press works both
legs inside the set, so it carries the same `defaultSets` and the same muscle
fractions as the bilateral version. Counting it double would report a volume
increase for doing the same work — pinned by a test.

**Straight sets lengthen the rest.** In a superset the gap between two sets of
the same lift is the interval, plus the partner's set, plus the interval again.
Running straight at the superset's own 90s would be a real cut in rest while
claiming to be a neutral convenience, so `straightSetRestSeconds` doubles it,
capped at five minutes. A swapped-in lift inherits the grouping of the slot it
fills, not its own, since a stand-in rarely has a superset group.

**Reversible?** Yes. Both fields are optional and absent on plan v1 and v2 data.

---

## 21. Optional sync, which supersedes section 2's no-server rule

Section 2 says: *"No server, no accounts, no sync, no analytics, no telemetry.
If a task appears to need one, the task is wrong."* The README led with **"No
server. No account. No sync. Your data stays in your browser."**

That is being reversed deliberately, and it costs something real: it was the
line that made this project distinctive next to every other fitness app.

**The reason:** two devices, no sync, data stranded on whichever one was used
last. That is a product failure, and it beats an architectural preference.

**The honest new claim is "local-first, works fully offline, optional sync."**
Still unusual, still true. What must not happen is the old sentence quietly
disappearing, so this entry exists and the README says what changed.

**IndexedDB stays the source of truth for reads.** Supabase is a sync target,
not a replacement. Replacing Dexie with "fetch from Postgres on load" loses
offline, loses instant startup, and breaks the gym-with-no-signal case, which is
the actual use case. The app stays fully usable signed out — signing in turns
sync on; it is not a gate on the product.

**Nothing auth-related enters `packages/engine`.** The engine takes plain data.
That boundary is what makes it the portfolio piece.

### What syncs, and what deliberately does not

Synced: `sessions`, `sets`, `weights`, `intake`, `adjustments`, `foods`,
`foodLog`, `savedMeals`, `profile`, `target`.

**Not synced: `exercises`, `templates`, `plan`.** They are seeded identically on
every device from `data/plan.json`, and section 18 has a migration that
OVERWRITES them on a version bump. Syncing them means two devices on different
app versions fight forever, one pushing v3 rows and the other pushing v2. They
stay local until the program is per-user rather than global — a much larger
piece of work than sync, because `profile`, `target` and `plan` are all
single-row singletons.

### Bookkeeping lives beside the data, not inside it

`updatedAt` and deletions are recorded in `syncMeta` and `tombstones` rather
than as columns on the domain rows. Two reasons: the engine owns those shapes
and an `updatedAt` column is a persistence concern; and no read path has to
learn about sync, so no screen can start showing deleted sets because somebody
forgot a `where deletedAt is null`.

Deletes remove the local row and write a tombstone. A hard delete cannot sync on
its own — the other device cannot distinguish "deleted elsewhere" from "not
uploaded yet", so it re-uploads the row and the deletion undoes itself.

### The rule that matters most: an import is not a deletion

`importAll` replaces the local database wholesale. It marks every row dirty and
**emits no tombstones**. If replacing rows became a deletion each, restoring a
backup on a laptop would delete the phone's history too — the single worst
failure this layer could have. Rows the import lacked return on the next pull:
data comes back rather than vanishing. Pinned by a test.

Erase-history does the opposite and tombstones everything, because that one is a
deliberate deletion.

**Reversible?** The code, yes. Other people's data, no — multi-user is a
different project with real duties attached, and is not what this enables.

---

## 22. Barcode scanning: manual entry is the primary path, not a fallback

Photo/OCR recognition of food was raised and explicitly declined — see §16 and
`docs/FOOD-LOGGING-SPEC.md` §8, which lists "Photo recognition" and "an AI that
estimates a meal from a description" under what must not be built, for the same
reason CLAUDE.md keeps AI out of the calculation path: it produces a specific
wrong number that looks authoritative. **Barcode scanning was always the
correct scope** — a barcode is a lookup key, not a guess.

**`BarcodeDetector` does not exist on iOS.** Every iOS browser is WebKit, and
WebKit has never shipped it. Built against only the native API, this would work
on a desktop demo and silently fail on the one device that matters. Chosen:
feature-detect and use it when present (faster, no extra download), fall back
to `zxing-wasm/reader` otherwise, loaded lazily so nobody who never needs it
pays for the ~1 MB decoder. Its `.wasm` binary is served from jsDelivr by
default — no bundler configuration to get wrong, which is exactly the class of
mistake that broke the Vercel deploy and the Pages workflow earlier.

**The typed barcode field is not a degraded fallback UI — it is the primary
path**, with the camera as an accelerant. Camera access can be denied, absent,
or blocked by a non-secure origin (`getUserMedia` requires HTTPS; a LAN test
over plain http fails this exact way), and none of that may be able to take the
feature down. Verified: with no camera available at all, the field stays usable
throughout and the app falls back cleanly with a stated reason, no hang, no
console error.

**Every lookup outcome — found, suspect, incomplete, or an existing duplicate —
routes into `AddFoodForm` for a human to confirm before anything is written.**
One write path for the whole feature. A clean match does not skip the review
step either: it is one extra tap, in exchange for nobody's food list ever
getting a row they never looked at.

**`energyReconciles()` (packages/engine) exists only for third-party data.** A
person weighing their own food and typing the label's numbers is the ground
truth this project trusts; manually entered macros are never run through it.
Crowd-sourced Open Food Facts rows are — "missing or absurd macros are common"
per the food spec — and a row that fails the 4/4/9 check routes to the form
pre-filled with a stated reason, never a silent save. 20%, not tighter: fibre
is sometimes excluded from a label's own Atwater sum, alcohol is not
represented at all, and the job is to catch a wrong row, not to audit
legitimate labelling variance.

**Verified against the live API, not just fixtures.** Nutella
(3017620422003) returns 539 kcal / 6.3 g protein per 100 g — checked against a
direct `curl` of Open Food Facts and matched exactly in the running app.
Re-scanning the same barcode surfaces the existing row rather than duplicating
it. An unknown barcode reports not-found cleanly. What was **not** tested here:
decoding an actual barcode from a live camera feed — this environment has no
camera and no synthetic-video harness to feed one. The decode calls are
implemented against the library's documented behaviour, not camera-verified;
worth a real-device check once deployed.

**Reversible?** Yes. `zxing-wasm` is a single lazy-loaded import behind a
feature check, and `energyReconciles` is a pure function with no callers
outside the barcode path.

---

## 23. The rotation is derived, not stored — `templateOrder` already was it

PROGRAM-V3.md replaces the fixed weekly split with a rolling cycle: Upper A,
Lower A, rest, Upper B, Lower B, rest, repeat — "a queue, not a calendar."
The document's own closing note assumed this needed new schema: *"there's no
cycle position... you'd need a `cyclePosition` on the plan."*

**It doesn't.** `templateOrder` (§14) already records the plan's templates in
program order, for display sorting. That ordered list — `['upper-a',
'lower-a', 'upper-b', 'lower-b']` — **is** the rotation sequence. "What's
next" is a pure function of that list and the session history: find the most
recent session whose template is in the rotation, advance one position, wrap.
`nextInRotation()` (`packages/engine/src/rotation.ts`) does exactly this and
nothing is stored that was not already there — consistent with §5, nothing
derived is stored.

**A second explicit "cycle position" field was the alternative, and it is
worse**, not just unnecessary: it can drift from the session history (log a
session out of sequence and the stored position lies about what actually
happened) in a way a value recomputed from history every time cannot.

**The recommendation, not a gate.** `TodayScreen` marks the recommended
template with a "Next" badge but every template stays one tap away — the same
philosophy as exercise swaps. A rolling program that *forced* sequence would
fight the exact flexibility problem it exists to solve (PPL notes: "same
system over and over" was the complaint; a rigid rotation is a different
flavour of the same rigidity).

**`dueForRest()` implements the one rule the document treats as
non-negotiable** — "never three training days in a row" — as a nudge, not a
block, for the same reason.

**Reversible?** Yes. Both functions are pure, take plain arrays, and are not
called from anywhere that would need to change if the rotation model changes
again.

---

## 24. Deload counted by session, not by calendar week — 24 sessions, my call

A rolling program's own logic is that a week is not a meaningful unit — see
§23. The pre-existing deload timer (`deloadEveryWeeks`, `daysBetween(...) >=
weeks * 7`) measures exactly the thing the program now ignores. PROGRAM-V3.md
does not give a session-counted replacement number; the gap is mine to fill,
and it is written down here rather than picked silently.

**Chosen: `deloadEverySessions: 24`.** Four templates per full rotation, so 24
sessions is exactly six complete rotations — the same session-based logic v2's
"deload every 6 weeks" was already approximating (6 weeks x 4 sessions/week =
24 sessions, coincidentally the same number under the old fixed schedule). At
v3's ~4.7 sessions/week this lands the deload around week 5, slightly sooner
in calendar time than v2 — defensible, since v3's sessions individually run
lighter (69 sets/week vs 75) but arrive more often, and accumulated-session
count is a more direct proxy for fatigue than calendar time either way.

**The alternative was scaling to preserve v2's ~6-week calendar cadence**
(≈28 sessions). Not chosen: it optimises for a number the whole point of a
rolling program is to stop optimising for.

**`detectDeload` gained `deloadEverySessions` / `sessionsSinceBlockStart` as
an OPTIONAL pair, additive to the existing calendar fields, not a
replacement.** When both are supplied, session count decides "scheduled" and
the calendar check is bypassed entirely — verified live: a fixture with
5 sessions and calendar time far past `deloadEveryWeeks * 7` still declines to
fire. When either is missing, behaviour is byte-for-byte what it was before;
every one of the 22 pre-existing tests passes unmodified. A plan with no
`deloadEverySessions` — anything on program v1 or v2's schema — never sees the
new code path at all.

`accumulationSessionsSince()` counts sessions on or after the block start,
inclusive. That boundary is deliberately inclusive rather than exclusive: on
the very first block it is the date of the first real session, which must
count, and on every later block it is the date of the deload that started the
block, which the `isDeload` filter already excludes regardless — so inclusive
is safe in both cases without a second code path to keep in sync. Both
directions are pinned by tests.

**Reversible?** The number, trivially — it is one field in `plan.json`. The
additive schema change, yes at no cost: nothing currently depends on the
session-counted fields existing.

---

<!--
Template for new entries:

## 25. Skips are per-session and per-slot, the same shape as swaps

`Session.skips: string[]` drops a programmed exercise from today only. Keyed
by slot id, same key-space as `swaps`, so a slot cannot be both swapped and
skipped without an ordering rule — the app checks skips first, since dropping
a slot makes any swap on it moot. The template is never edited; next time
that slot comes up it is back, exactly like a swap reverting on its own.

**Skip is offered only before any working set is logged against the
exercise.** Once you have started it, "skip" and "I am done with this one"
mean the same thing, and the finish button already says that — a second
button for the identical action would just be two ways to ask the same
question. An ad-hoc addition nobody has logged a set against yet needs no
persistence at all: it only ever existed in local `pending` state, so
"skipping" it is just removing it from that array.

**Reversible?** Yes. `skips` is optional and additive, absent on every session
row that predates it.

---

## 26. Custom exercises are a plain row in the same table, id-prefixed

`createCustomExercise()` writes straight into `db.exercises` with an
id prefixed `custom-`. No new table, no parallel data model — `AddLift`
already searches every row in `exercises`, so a custom one is swappable,
addable and searchable the moment it exists, through exactly the same code
every plan-seeded exercise goes through.

**The prefix is what makes this safe under the existing migration model.**
§18's plan-version migration does `bulkPut(PLAN.exercises)`, which only
touches ids `plan.json` defines. A custom exercise's id is never one of
those, so no migration can ever overwrite, rename, or silently drop it —
verified structurally, not by convention alone, since `custom-` ids cannot
collide with `plan.json`'s hand-picked slugs by construction.

**Muscle fractions are inferred from tap order, not asked for.** First muscle
tapped gets 1.0 (primary), every other gets 0.5 (secondary) — the same
primary/secondary split the whole plan already uses (§9), applied
automatically rather than as a second decision mid-form. The form is meant to
be fast enough to fill in standing in a gym; asking for a numeric fraction per
muscle is not that.

**Not sync-tracked, same as every other row in `exercises`** (§21's
exclusion is table-level). A custom exercise made on one device does not yet
appear on a second. Worth revisiting once the sync client exists; not a
reason to hold this feature until then; see §21 and §23.

**A real bug this surfaced, fixed in the same pass:** `AddLift`'s new
"create custom" branch originally `return`ed before the component's
`useLiveQuery` call, so the hook ran on one render and not the next —
React error #300, a full crash of the picker the moment the button was
tapped. Hooks must run unconditionally, in the same order, every render; the
branch has to sit after every hook, never before one. Caught by the browser
verification pass for this feature, not by typecheck or the test suite —
neither one runs the component tree, and this class of bug only exists at
runtime.

**Reversible?** Yes. `custom` is an optional boolean; every existing
exercise is unaffected.

---

<!--
Template for new entries:

## 27. A persona review found a real bug: the pad ignored a deload toggled after mount

A month-long usage review (real interaction plus seeded history, not just
unit tests) found `LiftSheet`'s pad silently ignoring a deload toggled after
the lift had already rendered. The prescription card correctly recomputed
and displayed `2 × 6–10 @ 50 lb, RIR 4/4`; the pad underneath it — the thing
that actually gets logged on a tap — kept showing the pre-deload numbers,
`55 lb, RIR 2`, because the seed-once effect's guard (`if (pad !== null)
return`) does exactly what its comment says and never re-fires once `pad`
is set, even though `prescribed` is nominally a dependency. Tapping Log in
that state would have recorded a full-intensity set while the screen
implied a deload one.

**Fixed with a second, narrower effect**: `setPad(null)` on `[isDeload]`,
which lets the existing seed effect do its normal job on the next render.
This is the one case allowed to override "seed once and leave it alone" —
the prescription itself changed, not just the object identity of it.
Verified by reproducing the exact scenario (a real prior session's numbers
loaded, then deload toggled) and confirming the pad's load and RIR match the
prescription card afterward.

**Why a full review caught this and the test suite did not**: nothing in
`packages/engine` is wrong — `deloadPrescription` returns the right numbers
every time, proven by its own tests. The bug lived entirely in when a React
effect chooses to re-run, which only exists at runtime in a mounted
component. Same shape as §26's hooks-order crash: this project's tests cover
engine logic and are deliberately sparse on component behaviour (CLAUDE.md),
so this class of bug is caught by driving the real app, not by `npm test`.

**Reversible?** Yes, two-line change, no schema or data implication.

---

## 28. Program v5 replaces v3 wholesale with the 1x4 Method

`data/plan.json` bumped to file version 5. The rolling Upper/Lower v3 program
is gone; in its place is the **1x4 Method** (Eric Evans): four exercises per
session, one warm-up at 50% plus **one work set to absolute failure**, 6-10
reps with double progression, three main days plus one optional accessory day.
Requested directly (a photo of the routine dropped in `docs/`), and
implemented as a pure data change — the app is fully data-driven off the plan,
so no component, rotation, or progression code moved. §18's migration overwrote
the templates and the exercises they name; every v3 exercise stays in the
library so old logged sets still resolve (same precedent as v2 keeping the
deadlift, v3 keeping the dip).

**What changed in the data.** The 12 main-day lifts were retuned to
`defaultSets: 1`, `targetRirBySet: [0]`, `defaultRepRange: [6, 10]`. Every
superset group on a scheduled lift was cleared — the method is straight sets,
and a stale group would make the session screen silently pair two lifts. Four
new exercises were added because the v3 library had no triceps pushdown, neck,
grip, or ab-crunch movement: `cable-pushdown`, `neck-curl`, `wrist-roller`,
`cable-crunch`. `deloadEverySessions` was dropped — the 1x4 Method has a fixed
week, so the engine falls back to `deloadEveryWeeks` (the session-counted timer
existed only because v3 had no week; see §24).

**One engine schema change: a `neck` muscle group.** Neck curls had nowhere to
map. The alternatives were to drop the exercise (unfaithful to a plan the user
chose) or map it to a wrong muscle (violates "no silently-wrong number"). Added
`neck` to the `MuscleGroup` enum — additive, the exercise-creation UI derives
its options from `MuscleGroup.options` so it picked the value up with no code
change, and there is no exhaustive switch on the enum to break. Its volume
target is `min 0` because the accessory day is optional and should never read
"under".

**The honest cost, pinned as tests, not smoothed over.** The 1x4 Method trades
volume for intensity: a full four-day week is 16 work sets against v3's ~70,
and every priority muscle (side delts P1, upper chest P2, lat width / rear
delts P3, lower traps P4) gets ~1 direct set per week — far under the floors in
the user's own `volumeTargets`, which were left unchanged because the user's
physique goals did not move. So the volume screen will read red on exactly the
levers the user cares about most. Rather than lower the targets to make the
screen green, `apps/web/test/plan.test.ts` and `packages/engine`'s
`volume.test.ts` assert the under-target reality directly, the same way v3's
suite pinned its own shortfalls. Failure on the RDL and presses is likewise the
method as written, flagged in the exercise notes rather than quietly softened.

**Reversible?** Fully — it is a data file plus one additive enum value. Git
history holds v3 verbatim if it is ever wanted back.

---

## 29. Rechecking v5 against the source photo found one real bug: `notes` was dead data

Asked to recheck whether the shipped 1x4 Method aligns with the routine as
photographed (`docs/WhatsApp Image 2026-08-24 at 10.37.59.jpeg`). The
structure held up under a field-by-field comparison — 4 templates, 4 lifts
each, `defaultSets: 1` / RIR 0 / 6-10 reps on every main-day lift, straight
sets, the exercise names all map onto the library, and `plan.test.ts` already
pins the shape (§28) rather than just asserting it by eye. The accessory
day's wider rep ranges (8-12 / 10-15, not 6-10) are a deliberate, already-
documented exemption, reasoned about in `plan.test.ts`'s own comment, not an
oversight.

One real gap turned up: `Exercise.notes` — the field carrying the method's
safety-critical nuance ("stop the instant the lower back rounds", "widen back
to 12-20 here if the shoulder joint complains") — was written into every v5
exercise but never rendered anywhere in the app. It existed only as an
argument to `createCustomExercise` and otherwise sat unused in `plan.json`.
For a program whose signature move is "take it to true failure," the one line
telling a lifter when to stop early is exactly the wrong thing to leave
unread. Fixed by printing `exercise.notes` in `LiftSheet.tsx`, styled as the
same `.hint` class used everywhere else, directly under the prescription's
reason line. Verified with a real page load on the RDL slot (the longest note
in the plan): it renders, and the pad — the one thing the "nothing scrolls
mid-set" rule actually protects — still fits the viewport without scrolling.
The info card above it can scroll on its own if a note runs long; that
was already true of the reason line and the logbook table before this change.

Also found and fixed: `README.md` and `CLAUDE.md` still described program v3
(the rolling Upper/Lower split, differentiated RIR ladders, default supersets,
session-counted deload) as the current program, and both had stale test
counts predating even that. Both now describe v5, with the counts corrected
to 291 (217 engine + 74 app).

**Reversible?** Fully — a rendered `<p>` and prose edits, no schema or data change.

---

## 30. Program v6: a four-day PPL split, and a gym-session timer

Two requests in one turn. Both shipped; the reasoning that needed a decision is
below.

**The program (v6, `plan.json`).** The 1x4 Method's isolation-only design was
replaced with a four-day Push / Pull / Legs / Shoulders-Arms-Abs split, still
failure-trained but with the big compounds mixed back in (weighted dip on Push,
weighted pull-up on Pull, back squat on Legs). Every exercise is now **two** work
sets. Front delts became the stated priority — a new `db-shoulder-press` (front
delts as the primary mover) appears on both Push and Day 4, and `frontDelts`
became a priority-2 volume target at a 6-set floor. Abs (cable crunch) live on
Day 4. Like every version bump before it this is a pure data change: templates
replaced, the lifts they name retuned, every earlier exercise kept in the
library so old logged sets still resolve.

**The one judgment call: failure on the compounds.** "Make every exercise 2 sets
of failure" collides with reintroducing the back squat — two sets of a barbell
squat to *absolute* failure is the highest-injury-risk thing in a gym (you fail a
squat by getting pinned under it). Put to the user as an explicit choice; they
picked the coached carve-out. So isolation is `targetRirBySet: [0]` (true
failure) and the four systemic lifts — squat, RDL, weighted pull-up, weighted dip
— are `[1]` (form-failure, stop when form breaks). `plan.test.ts` pins exactly
that split. "Not to failure on a deload" needed nothing in the data:
`deloadPrescription` already overrides the ladder to RIR 4 and halves the sets
(§ progression), so two failure sets become one back-off set automatically.

The honest cost, pinned as tests: the PPL structure carries no dedicated
upper-chest or lat-width work, so those two old priorities read `under` on the
volume screen (each gets ~2 sets against a 6-set floor). Front and side delts —
the shoulders the split actually trains — land in range. Called out in
`plan.test.ts`, not fixed behind the user's back; adding a lift is their call.

**The timer.** Wall-clock time in the gym, first working set to finish,
"regardless of pauses". Built engine-first: `session.ts` has pure, tested
`firstWorkingSetAt` (warm-ups do not start the clock — the button that starts it
is literally "Log set 1", not "Log warm-up"), `elapsedSeconds` (clamped
non-negative, so a backwards device clock cannot report a negative session), and
`gymTimeSeconds`. Only one new stored field — `Session.finishedAt`, the instant
the user tapped Finish; the START stays derived from the first set, keeping to
"nothing derived is stored" (§5). `SessionScreen` shows a once-a-second live
clock during the session and a full-screen total on finish. Verified by driving
the real app: the clock started on the first working set, ticked in real time
while the rest timer ran independently, the finish summary showed the total, and
reopening the finished session showed the frozen time rather than a ticking one.

**Reversible?** The program is data plus one new exercise; the timer is one
optional schema field, one pure engine module, and UI. Git history holds v5.

---

## 31. Two real bugs found rechecking v6: dead Upper/Lower rows, and a session that started itself

Asked to reverify v6 — reading nutrition and session code the way a
nutritionist or a fresh-user pass would use it, since a browser driver was not
available in this environment (a code trace, not the real-app pass §27 and §30
got). It found two things, both fixed.

**Migrating a plan version never actually deleted a template.** §30 says
"templates replaced, not merged" and `seed.ts`'s own comment said the same —
but the code was `db.templates.bulkPut(PLAN.templates)`, and `bulkPut` only
upserts. Every version bump since v3 (`upper-a`/`lower-a`/`upper-b`/`lower-b`,
the old rolling Upper/Lower cycle) left those four rows sitting in
`db.templates` forever, because nothing had a reason to write to them — v5 and
v6 both introduced entirely new template ids and never touched the old ones.
`TodayScreen` lists every row in that table, so the dead Upper/Lower days kept
showing up underneath the real four-day program (sorted to the end, per its
own "anything not in the plan's list sorts to the end rather than
disappearing" comment — visible, not gone). Fixed by deleting whatever id is
not in the incoming plan before the `bulkPut`, exactly once, on the same
migration path. `seed.test.ts` pins it by seeding a fake pre-v6 database
(the real `upper-a`/`lower-a` ids) and asserting they are gone after
`seedIfNeeded()`, while a hand-added template with no version to migrate from
survives untouched.

**Opening a session screen created the session.** Deliberate as of §30's
timer work — "created on arrival... so a session you walked out of still
exists as a record of the day" — but that reasoning only covers actually
training and getting interrupted. It also covered the much more common case of
tapping into a day purely to see what is programmed, then backing out having
logged nothing. That is not a cosmetic problem: `nextInRotation` and
`accumulationSessionsSince` (packages/engine/src/rotation.ts) both key off "a
session row exists for this date", not off any set being logged, so a bare
look silently advanced the rotation queue and ticked up the session-counted
deload timer. Fixed by splitting the read from the write: `existingSessionId`
looks a row up without creating one, and `startSession` (renamed nowhere,
same function) now only ever gets called lazily, at the first thing that
actually needs to persist — a logged set, a deload/superset toggle, a swap, a
skip. `queries.test.ts` pins the read side (looking creates nothing;
`startSession` is idempotent and keyed per template+date); the write side is
exercised by every existing session test that still passes with a session
created out from under it instead of in front of it.

**One accepted asymmetry.** A flag toggled before any set is logged — previewing
the deload prescription, then leaving — still creates the session row, same as
before. Only a bare look-and-leave with zero interaction is now free. Drawing
the line at "any write" rather than "specifically a set" keeps one function
(`ensureSessionId`) instead of buffering pending flag changes until a set
exists; revisit if toggle-then-abandon turns out to be common enough to matter.

**Reversible?** Yes, both are data-migration and query-layer changes with no
schema shape change; `finishedAt`, `Session`, and every other stored shape are
untouched.

---

## 32. §31's own fixes didn't reach an already-running device — a lesson about "fixed" vs "fixed for you"

Deployed §31, was told the Upper/Lower rows and the double "in progress" were
still there. Both reports were correct, and both were §31 being genuinely
incomplete rather than the deploy failing — confirmed by diffing the live
bundle byte-for-byte against the build that contained the fix. Two separate
gaps, same shape: a fix that is only correct for events happening AFTER it
ships, on a database that already has the bad state baked in from before.

**The template cleanup was gated behind `isUpgrade`.** §31 deleted a stale
template id, but only inside the `isFirstRun || isUpgrade` branch — the branch
that runs on a version bump. A device already sitting on v6 (the plan version
has not changed since §31 shipped) never sets `isUpgrade` true again, so the
cleanup code was live but **structurally unreachable** for anyone not in the
middle of an actual migration. It would have started working retroactively
the day the plan bumps to v7 — everyone else keeps the dead rows forever.
Fixed by moving the reconciliation out of the branch entirely: it now runs on
every `seedIfNeeded()` call, unconditionally, and is a no-op once a device is
clean (confirmed by a new test asserting exactly that). The test suite §31
shipped never caught this because every test seeded a *version bump*
scenario — there was no test for "already on the current version, still
carrying a stale row", which is the actual shape of an already-deployed user.

**The lazy session creation only stopped new empty rows.** §31's fix to
`startSession` was correct on its own terms — a session opened purely to look
no longer creates a row. But a device that had already opened Push and Pull
before that code existed was carrying two real, empty session rows from
before the fix, and nothing in §31 touched existing data. Those rows kept
reading as "in progress" because the bug they came from had already happened;
preventing it from happening again does nothing to data it already produced.
Fixed with `pruneEmptySessions` — deletes any session with zero sets logged
against it, run on every startup alongside seeding. This is also the thing
that makes §31's "one accepted asymmetry" (a flag toggled with nothing logged
still creates a row) stop mattering in practice: that row is empty, so it gets
swept on the next load regardless of which write created it.

**The actual lesson.** A migration or a lazy-write fix is only "done" for a
device that has not yet touched the broken path. For everyone who already
has, the fix needs an explicit reconciliation step run on real data, not just
corrected logic for the next time the bad path would have fired. Worth
checking for on every future migration in this file, not just these two.

**Reversible?** Yes. `pruneEmptySessions` deletes rows with zero children,
which by construction carried no information; the template reconciliation
change only removes gating, not behavior.

---

## 33. Today's day list is manually reorderable, and it is screen state, not plan state

Requested directly: the plan version changed which day is listed where (v6's
PPL order is not v3 or v5's), and after training out of the recommended order
for a few sessions the visible list no longer matched what was actually left
to do. Rather than trying to make the list auto-arrange around "what's left"
— which would have to guess intent every time — the day list is now just
manually reorderable: a ▲/▼ pair on each row, one tap moves it one position,
repeated taps get it anywhere. No drag: HTML5 drag-and-drop does not work
reliably on touch, and a queue of small precise taps fits this app's existing
interaction style (skip, swap, favourite are all taps, nothing here drags)
better than pulling in a pointer-based DnD library for four rows.

**The one real decision: this is NOT `PlanMeta.templateOrder`.** That field is
two things today — the plan's own display order AND the ROTATION order
`nextInRotation` reads. Overloading it a third way, as a user's manual
arrangement, would mean rearranging your own screen changes which day the
rotation recommends next, which is a bug wearing a feature's clothes: "Next"
is supposed to mean "what the queue says is next," not "whatever happens to
be on top." So this is a new table, `uiPrefs` (v5 schema bump, one row,
`templateOrder: string[]`), read only by Today's own render, and deliberately
NOT synced (see sync-bookkeeping.ts's `SYNCED_TABLES`) — same category as
`plan` and `templates` themselves, a per-device fact rather than training
data. `nextInRotation` keeps reading the plan's order, unchanged; `Today`
reads `orderedTemplateIds(baseOrder)`, which lays the saved arrangement over
the plan order and appends anything the arrangement has not seen (a new
install, or a day a later plan version adds) rather than hiding it.

**Also confirmed while here: the gym-session timer (§30) is intact.** Nothing
in §31/§32's session-lifecycle rework touched `gymSeconds`/`firstWorkAt`
derivation — it still shows a live "In the gym" clock in the lift head while
training and a full-screen total on the finish summary, both driven by
`session.ts`'s pure functions, unaffected by when the session ROW itself gets
created.

**Reversible?** Yes — `uiPrefs` is a new, empty-by-default, unsynced table;
deleting it loses only the arrangement, never any training data, and Today
falls straight back to plan order.

---

<!--
Template for new entries:

## N. <the decision, stated as a claim>

<what was chosen, and the one or two alternatives that were real>

<the reason, including the cost being accepted>

**Reversible?** <yes/no, and at what cost>
-->
