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

<!--
Template for new entries:

## N. <the decision, stated as a claim>

<what was chosen, and the one or two alternatives that were real>

<the reason, including the cost being accepted>

**Reversible?** <yes/no, and at what cost>
-->
