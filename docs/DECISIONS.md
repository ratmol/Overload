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

## 7. The warm-up bias is disclosed, not corrected

The EWMA slope is biased toward zero for the first ~8 weeks (see ALGORITHM.md
§1.1). Bias-correcting a hand-seeded EWMA introduces its own artefacts, and the
correction would be least trustworthy exactly when it matters most.

**Chosen:** expose `warmingUp`, cap confidence at `low`, and let the existing
guardrails prevent action. The engine says "I do not know yet" rather than
guessing.

This matters more than it sounds: an understated gain rate reads as "not gaining
fast enough", and the naive response is to add calories. During month one that is
precisely backwards.

---

## 8. energyDensityPerLb = 2500 on a gain, not the computed 1850

A 60/40 lean-to-fat accrual ratio computes to ~1850 kcal/lb. We use 2500.

Overestimating the density makes the engine under-correct — it attributes a
weight change to fewer calories than really caused it, so it moves the target
less. On a lean gain, under-correcting means drifting slightly off target rather
than oscillating around it, which is the safer failure mode.

1850 is the physiologically honest number; 2500 is a conservative engineering
choice. The gap is a decision, not an error, and it is user-overridable.

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

<!--
Template for new entries:

## N. <the decision, stated as a claim>

<what was chosen, and the one or two alternatives that were real>

<the reason, including the cost being accepted>

**Reversible?** <yes/no, and at what cost>
-->
