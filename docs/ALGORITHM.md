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
the *slope* of the trend is biased toward zero early on. Measured over 25 seeds
at a true 0.4 lb/week gain with 0.8 lb daily noise (pinned by a test, so this
table cannot drift away from the code):

| History | Recovered rate | Error |
|---|---|---|
| 28 days | 0.275 lb/wk | **31% low** |
| 35 days | 0.352 lb/wk | 12% low |
| 42 days | 0.374 lb/wk | 6% low |
| 56 days | 0.390 lb/wk | 3% low |
| 63 days+ | 0.410 lb/wk | ~2% high |

**Why this matters practically.** An understated rate of gain looks like "you
aren't gaining fast enough", and the adjustment logic responds by *adding*
calories. During the first two months, that is exactly backwards. This is the
single most likely way a naive implementation of this engine makes you fatter.

**What we do about it.** We do not correct the bias — bias-correction on a
hand-seeded EWMA introduces its own artefacts. Instead `isWarmingUp()` returns
true below **eight** half-lives (56 days) of history, and `estimateTdee` caps
confidence at `low` while it holds, and `adjustTarget` hard-blocks on it.

An earlier version used four half-lives (28 days), which released the gate at
the point of *maximum* bias — the worst possible place to put it. The bias only
falls under 5% around 56 days.

`isWarmingUp` also checks the number of *real* readings, not just the calendar
span. `computeTrend` carries the trend forward across gaps, so two readings 60
days apart produce a 61-point series that would otherwise read as fully settled.

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

**Correcting an error that was in this document:** the excess from a naive 3500
constant is **~95 kcal/day, not 200**. 200 kcal/day is the *total* the 3500
figure attributes at 0.4 lb/week; the honest figure is 105, so the difference is
95. An earlier draft mistook the total for the difference and overstated the
flagship justification by 2x. Still worth fixing — 95 kcal/day over six months
is real — but the honest number is the one that belongs here.

| Phase | Constant | Reasoning |
|---|---|---|
| gain | **2500** | 60/40 accrual computes to ~1850. We use 2500 deliberately. |
| loss | **3200** | Loss is fat-dominant but not purely fat. |
| maintain | 2500 | No meaningful direction; reuse the gain figure. |

**Why 2500 and not the computed 1850 — and a correction.**

An earlier version of this document justified 2500 by claiming that
overestimating the density makes the engine *under-correct*. That reasoning was
wrong, with the sign inverted twice:

- Overestimating density attributes a given weight change to **more** calories,
  not fewer.
- In `adjust.ts` the delta is `rateError x density / 7`, so a **larger** density
  produces a **larger** correction. 2500 over-corrects relative to 1850 by 35%.

The value survives the correction; the reasoning does not. Redoing the
derivation with more defensible inputs — 45/55 lean-to-fat partitioning (60/40
is the optimistic ceiling for a trained lifter, not a central estimate), and a
lean deposition cost of ~1150 kcal/lb once protein synthesis and turnover
inefficiency are included rather than stored energy alone:

```
0.45 x 1150 + 0.55 x 3600 = 517 + 1980 = 2497
```

2500 is what honest inputs produce. The 1850 figure came from using 750 kcal/lb
(stored energy in lean tissue, ignoring the metabolic cost of depositing it) and
an optimistic partitioning ratio.

Because the TDEE identity and the adjustment gain have **opposite** error
sensitivities, the conservatism that used to be smuggled into this constant now
lives where it can be seen: an explicit `damping` factor of 0.6 in `adjust.ts`.

Configurable per user via `energyDensityOverride`, bounded to [800, 4300] — less
than lean tissue or more than pure lipid is a typo, not a preference.

`test/tdee.test.ts` contains a test asserting the gain constant is below 3500,
purely so nobody "fixes" it back to the textbook number.

### 3.2 Confidence

Combined to low / medium / high, in priority order:

1. **Warming up** (trend history < 56 days) → always `low`. See §1.1.
2. **Last weigh-in more than 3 days old** → always `low`. Otherwise the intake
   and weight halves of the identity are measured over different stretches of
   time, which is an energy-balance violation, not a cosmetic issue.
3. **Weigh-in coverage below 50%** → always `low`. Distinct from intake
   coverage and easy to miss: the trend series is always dense because gaps are
   carried forward, so weekly weigh-ins regressed as though daily read ~38% low
   at "high" confidence.
4. **Under 14 logged days** → always `low`.
5. **Intake coverage below 70%** → capped at `low`.
6. **Coverage >= 90%, window >= 28 days, weigh-in coverage >= 80%, intake sd <
   400 kcal** → `high`. Gated on coverage rather than an absolute day count:
   the old `loggedDays >= 28` on a 28-day window meant 100% logging, so one
   missed day capped confidence at medium forever.
7. Otherwise → `medium`.

Displayed as a range, never a bare number: `2,475 kcal (2,325-2,625), medium`.

The half-width is `1.96 x SEM` of daily intake totals, **floored at 150 kcal**
and rounded to 25. That floor is a deliberate honesty measure, not arithmetic.
The interval covers the *intake* term only; it omits slope uncertainty and
density uncertainty entirely. Propagating slope uncertainty correctly is harder
than it looks, because the regression runs over an EWMA-**smoothed** series
whose points are heavily autocorrelated — at a 7-day half-life over 28 days the
effective sample size is nearer 4 than 28, so a naive OLS standard error would
understate by roughly 2.5x. The true interval is plausibly 2-3x wider than the
arithmetic suggests, so a +/-60 kcal range next to the word "confidence" was
false precision of exactly the kind that makes someone trust an automated change
they should have questioned.

TDEE is also rounded to 25 kcal. Reporting it to the single calorie implies a
precision that does not exist.

### 3.3 Shift days vs off days — a function that was removed

A standing retail shift can run 300-500 kcal above a rest day, so eating a flat
number likely means a surplus on off days and roughly maintenance on shift days.
That is a real problem and MacroFactor does not model it.

**The engine no longer claims to solve it.** `estimateTaggedExpenditure` was
deleted and replaced with `summariseTaggedIntake`, which reports a descriptive
statistic and nothing more. The original was not defensible:

- **It was circular.** `shift - off` came out algebraically identical to
  `meanIntake(shift) - meanIntake(off)`. The function never touched the weight
  trend, so it contained exactly zero evidence about expenditure. Once the app
  started issuing split targets, the next window's intake difference would equal
  the prescribed difference, which the engine would re-attribute to expenditure
  — self-confirming, with no external anchor.
- **The `[0, 600]` clamp censored the disconfirming direction.** A user who is
  busier and eats *less* on shift days — the common retail case, and the one
  where a split target actually matters — was told "no measurable difference,
  eating the same on both is fine." That is the opposite of the truth.

The replacement reports the signed difference, a Welch interval on it, and
whether it clears its own noise floor. That last part matters: with daily intake
sd around 200 kcal and a few weeks per tag, the sampling margin alone is roughly
+/-120 kcal, so a fixed "is it more than 50 kcal?" cutoff would report pure
noise as a finding most of the time.

The honest version of the expenditure question needs step count as a direct
input, or a regression of daily trend change on intake with a tag dummy over far
more than 7 days per tag. Until then, describe what was measured.

---

## 4. Calorie adjustment guardrails

Every one of these is a hard block, and every one has a test written before the
feature. The engine declining to act is correct far more often than acting on
thin data.

```
- No adjustment while the trend filter is warming up (< 56 days history)
- No adjustment at low confidence, for any reason confidence is low
- No adjustment on a non-finite slope or density
- No adjustment with fewer than 14 logged days in the window
- No adjustment below 70% intake coverage
- Maximum +/-100 kcal per adjustment
- Maximum one adjustment per 14 days
- Only 60% of the computed correction is applied (damping)
- No adjustment while the observed rate is inside the target BAND
- No adjustment during a deload week, or within 3 days after one
- No adjustment if the user has locked calories
- No adjustment below the 1600 kcal floor
- No adjustment below the low end of estimated expenditure on a gain phase
- Changes below 25 kcal are treated as zero, not rounded up to 25
- Escalate to needs-review instead of adjusting when good data still will not move
- Every adjustment stores a human-readable reason string
```

**The three that were missing.** The warming-up and low-confidence blocks were
described in this document, in the package README, and in CLAUDE.md — and did
not exist in `adjust.ts`. The adjustment engine was acting on data the estimator
itself had labelled untrustworthy. There were no tests for either, which is
precisely why the gap survived. Documentation is not a guardrail.

**Why a band, not a point.** The training plan specifies 0.25-0.5 lb/week. An
engine comparing against a scalar with a 25 kcal rounding step had an effective
deadband of 0.035 lb/week — far below what a smoothed scale trend can resolve —
so its steady state was a +/-100 kcal move nearly every cycle, usually at the
cap. Inside the band, do nothing. Outside it, correct toward the nearest *edge*,
because aiming at the middle guarantees overshooting half the time.

**Why 14 days and damping.** This is a controller with a 2-3 week lag. Adjusting
weekly into that lag is textbook integral windup: it stacks corrections for a
change it cannot see yet. The concrete failure — starting creatine and raising
carbs adds 2-4 lb of water and glycogen over a fortnight, which reads as ~1
lb/week of "gain" and invites repeated cuts for something that was never tissue.

**Why a floor.** Nothing else in the system bounded a downward ratchet: at 100
kcal/week with no floor, a target can reach RMR in under three months. 1600 is
roughly 1.15x an estimated RMR of ~1394 for this user, and below it the plan's
own minimums (130 g protein, 60 g fat floor) consume two thirds of intake and
leave no training fuel, making the plan internally incoherent.

**Why needs-review.** The engine's only vocabulary for a flat trend used to be
"add 100 more calories", forever. A verified surplus with no response over
several cycles is close to the textbook presentation of the causes the training
plan lists as highest priority to rule out — iron and ferritin, B12, vitamin D,
TSH, celiac. The engine now stops and says so rather than absorbing a medical
signal into weekly calorie increments.

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
- **Two consecutive failed transitions** with no gain in *either* reps or load
  → `stalled`. That needs three data points, not two. Comparing a single pair
  flagged a stall after one flat session, and with a 2-lift threshold two flat
  lifts on one bad day became a fatigue signal.
- Deload sessions are excluded entirely. They run at ~87.5% with belt weight
  stripped, so they look identical to a regression; counting them meant the
  first session back read as a stall and could trigger a second deload.
- A load increase requires the **full prescribed set count**. `every` is
  vacuously true on a single set, so a session cut short after one good set used
  to earn a load increase.
- Where `entryStandardReps` is set (10 on pull-ups, 12 on dips), no load is
  added until every set clears it. The one hard safety rule in the plan's
  loading section, and it also applies coming out of a deload.

"Gain" is total reps at equal-or-higher load. A session where load rose and reps
fell is progress, not a stall — a naive total-reps comparison gets this wrong and
would flag every successful load increase as a stall.

Increment is 2.5 lb on bodyweight-loaded lifts. At 132 lb bodyweight a 5 lb jump
on a pull-up is a 4% system-load increase, which is a large step and the single
most common thing people get wrong on these lifts.

### 5.3 Deload triggers

Fires at the end of **6 weeks of accumulation** (so the deload is week 7),
**or** on two or more of:

- 2+ lifts flagged stalled in the same week
- RIR trending down at constant load (same work, more effort)
- Self-reported sleep quality below 3 for 4+ consecutive sessions
- Joint pain flagged on 2+ consecutive sessions
- Resting heart rate 5+ bpm above personal baseline for 3+ sessions
- Genuine dread about training on 2+ consecutive sessions

The timer was previously set at `>= 7 * 7` days, which fired on day 49 — a full
week late, on a dip- and pull-up-heavy program.

Resting HR requires a **personal baseline**; an absolute bpm threshold is
meaningless when 48 and 70 are both normal for different people.

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
