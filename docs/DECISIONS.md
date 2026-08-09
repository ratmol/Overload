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

<!--
Template for new entries:

## N. <the decision, stated as a claim>

<what was chosen, and the one or two alternatives that were real>

<the reason, including the cost being accepted>

**Reversible?** <yes/no, and at what cost>
-->
