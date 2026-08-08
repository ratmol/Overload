# ALGORITHM.md

Every number this engine produces, and the assumption behind it. Written as the
code was written, not after. If you change a constant here, change the test that
pins it in the same commit.

---

## 1. Weight trend — EWMA

Exponentially weighted moving average, half-life 7 days.

```ts
alpha = 1 - 0.5 ** (1 / halfLifeDays)   // ≈ 0.0943 at 7 days
trend[i] = alpha * raw[i] + (1 - alpha) * trend[i - 1]
```

**Seeding.** `trend[0]` is the mean of the first up-to-3 readings, not the first
reading. Seeding from one number makes the first fortnight of trend a function
of a single possibly-bad scale reading.

**Missing days.** The trend carries forward. We never interpolate a synthetic
reading, because a synthetic reading is indistinguishable from a real one later
when TDEE coverage is computed, and coverage is what caps confidence.

**Not a Kalman filter.** EWMA is six lines and handles the overwhelming majority
of the problem. A Kalman filter is a refinement worth making after EWMA has been
in daily use for a month, and it is a good blog post. It is not a starting
point.

### 1.1 The warm-up bias — the most important caveat in this file

An EWMA seeded from a short mean lags a genuine trend while it catches up, so
the *slope* of the trend is biased toward zero early on. Measured on synthetic
data at a true 0.4 lb/week gain:

| History | Recovered rate | Error |
|---|---|---|
| 42 days | 0.24-0.37 lb/wk | up to 40% low |
| 60 days | 0.39 lb/wk | ~3% low |
| 90 days | 0.38-0.40 lb/wk | <5% |

**Why this matters practically.** An understated rate of gain looks like "you
aren't gaining fast enough", and the adjustment logic responds by *adding*
calories. During the first two months, that is exactly backwards. This is the
single most likely way a naive implementation of this engine makes you fatter.

**What we do about it.** We do not correct the bias — bias-correction on a
hand-seeded EWMA introduces its own artefacts. Instead `isWarmingUp()` returns
true below four half-lives (28 days) of history, and `estimateTdee` caps
confidence at `low` while it holds. Combined with the adjustment guardrails,
that means the engine does not act on a warming-up trend.

### 1.2 Slope

Least-squares regression over the trailing window, not `(last - first) / days`.
The endpoint version is hostage to whatever happened on the two boundary days.
Returns `null` below 7 points.

---

## 2. Outlier handling

Median absolute deviation, scaled by 1.4826 so one MAD ≈ one standard deviation
on normal data and the threshold means what a reader expects.

**Readings are downweighted, never deleted.** A flagged reading has its alpha
halved and stays in the log with `flaggedOutlier: true`. The UI surfaces it so
you can confirm or correct. Silently deleting user data is the one thing this
project will not do.

### 2.1 Two calibration mistakes we made and fixed

Both were caught by running the detector over 25 seeds of synthetic data rather
than eyeballing one series. The tests that pin them are in `trend.test.ts`.

**Mistake 1: testing against a trailing median.** The first version compared
each reading to the median of a trailing 10-day window. Inside a real weight
trend, a trailing median sits roughly half a window behind the present, so the
comparison measures *drift plus noise* rather than noise. On a 0.4 lb/week gain
with realistic scale noise this flagged about **12% of ordinary readings**.

Fix: test the residual `raw - trend` against the MAD of recent residuals.
Residuals are trend-free by construction.

**Mistake 2: a 3-MAD threshold.** With residuals the false-flag rate dropped to
~5%, still far above the ~0.3% that 3 sigma implies. The cause is that a MAD
estimated from a two-week window is itself noisy and periodically comes out too
small, producing bursts of flags.

Fix: threshold 4 MAD, window 21 days, minimum 10 residuals, and a hard floor of
0.4 lb on the scale estimate. The floor matters because a run of identical
readings drives the MAD to zero and makes the next 0.2 lb wobble look infinitely
extreme.

**Current calibration:** mean false-flag rate below 2% across 25 seeds, worst
case below 6%, while still catching a 6 lb clothed weigh-in on every seed.

The asymmetry is deliberate. A missed outlier costs one slightly-wrong trend
point. A false flag halves the weight of a *legitimate* reading, so an
over-eager detector produces a trend that ignores real movement — the opposite
of what it is for.

---

## 3. TDEE estimation

```
TDEE ≈ meanIntake(window) − (trendSlopePerDay × energyDensityPerLb)
```

### 3.1 energyDensityPerLb is not 3500

This is the parameter that separates a credible tool from a toy.

3500 kcal/lb is the energy density of **body fat**. Tissue gained during a lean
gain is a mix, and lean tissue is mostly water — roughly 700-800 kcal/lb.

At a realistic 60/40 lean-to-fat accrual ratio:

```
0.4 lb/week gain = 0.24 lb lean (×750)  = 180 kcal
                 + 0.16 lb fat  (×3500) = 560 kcal
                 = 740 kcal/week ≈ 105 kcal/day surplus
```

A naive 3500 constant would prescribe roughly 200 kcal/day more than needed,
which over six months is several pounds of avoidable fat.

| Phase | Constant | Reasoning |
|---|---|---|
| gain | **2500** | 60/40 accrual computes to ~1850. We use 2500 deliberately. |
| loss | **3200** | Loss is fat-dominant but not purely fat. |
| maintain | 2500 | No meaningful direction; reuse the gain figure. |

**Why 2500 and not the computed 1850.** Overestimating the density makes the
engine *under-correct*: it attributes a given weight change to fewer calories
than really caused it, so it moves the target less. On a lean gain, under-
correcting is the safer failure direction — you drift slightly off target rather
than oscillating. 1850 is the physiologically honest number and 2500 is the
conservative engineering choice; the gap is a decision, not an error. It is
configurable per user via `energyDensityOverride`.

`test/tdee.test.ts` contains a test asserting the gain constant is below 3500,
purely so nobody "fixes" it back to the textbook number.

### 3.2 Confidence

Three inputs, combined to low / medium / high, in priority order:

1. **Warming up** (trend history < 28 days) → always `low`. See §1.1.
2. **Under 14 logged days** → always `low`.
3. **Coverage below 70%** of the window → capped at `low`.
4. **28+ logged days with intake sd < 400 kcal** → `high`.
5. Otherwise → `medium`.

Displayed as a range, never a bare number: `2,480 kcal (2,360-2,600), medium`.
The half-width is `1.96 × SEM` of window intake, floored at 60 kcal, rounded to
10. It is an interval on the *intake* term only — it does not propagate slope
uncertainty, so treat it as a lower bound on the real uncertainty. Widening it
properly is a worthwhile refinement.

### 3.3 Shift days vs off days

A standing retail shift can run 300-500 kcal above a rest day. Eating a flat
number means a surplus on off days and roughly maintenance on shift days.
MacroFactor does not model this.

Method: once both tags have ≥7 days in the window, attribute the difference in
*mean intake* between tag types to a difference in expenditure, then distribute
it around the pooled estimate by each tag's share of days.

**This is the weakest inference in the engine and it is bounded for that
reason.** Intake difference is a proxy for expenditure difference; you may
simply eat more on shift days for reasons unrelated to NEAT. The delta is
clamped to `[0, 600]` kcal, and returns `null` rather than a guess below the
minimum day count. The honest fix is step count as a direct input, which is a
later refinement.

---

## 4. Calorie adjustment guardrails

Every one of these is a hard block, and every one has a test written before the
feature. The engine declining to act is correct far more often than acting on
thin data.

```
- No adjustment while the trend filter is warming up (< 28 days history)
- No adjustment with a window shorter than 14 days
- No adjustment with fewer than 10 logged days in the window
- Maximum ±100 kcal per adjustment
- Maximum one adjustment per 7 days
- No adjustment during a deload week
- No adjustment within 3 days after a deload week
- No adjustment if the user has locked calories
- Changes below 25 kcal are treated as zero
- Every adjustment stores a human-readable reason string
```

**The reason string is the product.** If a plain-English explanation cannot be
generated, the change does not happen. That single rule is what separates this
from an app that silently moves your calories and expects trust.

Adjustment size is `(targetRate − observedRate) × energyDensityPerLb ÷ 7`,
clamped to ±100 and rounded to 25 kcal steps.

---

## 5. Training rules

### 5.1 System load

```ts
systemLoad = bodyweightOnSessionDate + addedWeight   // bodyweight-loaded only
```

Bodyweight comes from the weight log for that date, falling back to the most
recent **prior** entry. Never a later one — using a later reading would make
historical system loads change retroactively every time you step on the scale,
which makes progress charts lie.

Returns `null` when bodyweight is unknown. The UI must show `—`, not a
silently-wrong number that reads as a plateau.

This is the headline feature. +45 lb at 132 lb bodyweight and +45 lb at 142 lb
are a 10 lb difference in real work, and belt weight alone hides it. During a
deliberate lean gain that is the number one reason people believe they have
stalled on pull-ups and dips.

### 5.2 Double progression

- Every working set hit the top of the range → add one increment, reset to the
  bottom of the range.
- Otherwise → same load, chase reps.
- Two consecutive sessions with no gain in *either* reps or load → `stalled`.

"Gain" is total reps at equal-or-higher load. A session where load rose and reps
fell is progress, not a stall — a naive total-reps comparison gets this wrong and
would flag every successful load increase as a stall.

Increment is 2.5 lb on bodyweight-loaded lifts. At 132 lb bodyweight a 5 lb jump
on a pull-up is a 4% system-load increase, which is a large step and the single
most common thing people get wrong on these lifts.

### 5.3 Deload triggers

Fires on the scheduled 7-week timer, **or** on two or more of:

- 2+ lifts flagged stalled in the same week
- RIR trending down at constant load (same work, more effort)
- Self-reported sleep quality below 3 for 4+ consecutive sessions
- Joint pain flagged on 2+ consecutive sessions

Two-of-N rather than one-of-N because every single signal has a high
false-positive rate on its own. One bad night is not fatigue.

**Unreported days break a run rather than continuing it.** If sleep quality is
missing for a session, the run resets. Assuming an unlogged night was fine would
manufacture triggers from incomplete logging.

Deload behaviour: sets halved, load at ~87.5% rounded to the increment, added
weight stripped entirely from bodyweight-loaded lifts, **calories unchanged**,
and the adjustment engine frozen for the week plus 3 days. Recovery is
calorie-expensive; the instinct to eat less because you trained less is wrong.

### 5.4 Weekly volume audit

Hard sets per muscle over a rolling 7 days, against the ranges in
`data/plan.json`.

**A "hard set" is a non-warmup working set at RIR ≤ 4.** A set left 5+ reps short
does not drive meaningful hypertrophy, and counting it inflates the audit into
uselessness.

**Secondary muscles count fractionally** (0.5 for a meaningful secondary, 1.0 for
a primary). Counting a row as a full biceps set overstates arm volume; counting
it as zero understates it — and the plan deliberately runs near-zero *direct* arm
volume on the grounds that heavy pulling covers it, so getting this fraction
right is what makes the audit trustworthy at all.

---

## 6. What is deliberately not modelled

- **Body composition of the gain.** The engine tracks weight, not partitioning.
  Whether the surplus went to lean or fat is answered by DEXA, not arithmetic.
- **Step count / NEAT directly.** Approximated by the shift/off tag. Real step
  data would be strictly better.
- **Slope uncertainty in the confidence interval.** See §3.2.
- **Anything AI-driven in the calculation path.** A language model can summarise
  a week in prose. It does not compute a TDEE.
