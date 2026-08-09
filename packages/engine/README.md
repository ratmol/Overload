# @overload/engine

An adaptive body-composition engine that explains every number it produces.

Pure TypeScript. One runtime dependency (Zod). No browser, no network, no
storage layer, no framework. Everything here is a function from data to a
decision plus a human-readable reason for it.

```bash
npm test        # 154 tests
```

---

## Why this exists

Adaptive calorie tracking is a solved problem commercially and an unsolved one
in the open. MacroFactor does it well and is closed. Everything open either
skips the adaptive part or gets the arithmetic wrong in a specific, expensive
way.

This package is the interesting half of a personal training logger, extracted so
it can be tested and read on its own.

---

## The three things worth reading

### 1. The energy density constant is not 3500

Every naive TDEE implementation uses 3500 kcal/lb, because that is the number in
every article about weight loss. It is the energy density of **body fat**.

Tissue gained during a lean gain is not fat. It is a mix, and lean tissue is
mostly water at roughly 700-800 kcal/lb. At a realistic 60/40 lean-to-fat
accrual:

```
0.4 lb/week gain = 0.24 lb lean (×750)  =  180 kcal
                 + 0.16 lb fat  (×3500) =  560 kcal
                 =  740 kcal/week ≈ 105 kcal/day surplus
```

A 3500 constant misattributes roughly **95 kcal/day** at this rate. Over six
months that is real avoidable fat, produced by a tool the user trusted.

The number in that sentence used to say 200, which was wrong — 200 is the
*total* a 3500 constant attributes, and the honest figure is 105, so the
difference is 95. It is documented here rather than quietly corrected because
overstating your own headline finding by 2x is the kind of thing a reader should
be able to see you catching.

The constants are pinned to exact values by test. An earlier version asserted
only `gain < 3500`, which would have passed on a value of 1 — it pinned nothing
while three documents claimed it pinned the number.

### 2. The estimator is biased early, and says so

An EWMA seeded from a short mean lags a real trend while it catches up, so the
slope is biased toward zero for the first ~8 weeks. Measured on synthetic data
at a true 0.4 lb/week gain:

| History | Recovered rate | Error |
|---|---|---|
| 28 days | 0.275 lb/wk | **31% low** |
| 42 days | 0.374 lb/wk | 6% low |
| 56 days | 0.390 lb/wk | 3% low |
| 63 days+ | 0.410 lb/wk | ~2% high |

An understated gain rate reads as "not gaining fast enough", and the naive
response is to add calories — precisely backwards during month one.

The engine does not correct this. It detects it (`warmingUp`, at eight
half-lives — a four-half-life gate released at the point of *maximum* bias),
caps confidence at `low`, and hard-blocks the adjustment. Saying *I do not know
yet* is a feature.

A naive 3500 constant costs ~95 kcal/day at this rate, not the ~200 an earlier
draft of these docs claimed. The error was mistaking the total for the
difference; the honest number is still worth fixing.

### 3. Outlier detection was calibrated, not guessed

Downweight, never delete. A flagged reading has its EWMA alpha halved and stays
in the log for the user to confirm or correct.

Two calibrations were wrong before this one, and both were caught by running the
detector over 25 seeds rather than eyeballing one series:

| Version | False-flag rate | Problem |
|---|---|---|
| 3 MAD vs trailing median | ~12% | A trailing median inside a trend measures drift, not noise |
| 3 MAD vs trend residual | ~5% | MAD from a 14-day window is itself noisy and periodically too small |
| **4 MAD vs residual, 21d, floor 0.4 lb** | **<2% mean, <6% worst** | current |

The asymmetry driving the threshold: a missed outlier costs one slightly-wrong
trend point; a false flag halves the weight of a *legitimate* reading. An
over-eager detector produces a trend that ignores real movement, which is the
opposite of the point.

---

## Guardrails

The engine refuses to act far more often than it acts. Every guardrail has a
test written before the feature.

```
No adjustment while the trend filter is warming up (< 56 days history)
No adjustment at low confidence, for any reason confidence is low
No adjustment with fewer than 14 logged days, or below 70% coverage
No adjustment while the observed rate is inside the target BAND
Maximum +/-100 kcal per adjustment, and only 60% of the computed correction
Maximum one adjustment per 14 days
No adjustment during, or within 3 days after, a deload week
No adjustment below a 1600 kcal floor, or below estimated expenditure on a gain
No adjustment if the user has locked calories
Changes below 25 kcal are zero, not rounded up to 25
Escalate to needs-review instead of adjusting when good data still will not move
Every adjustment stores a human-readable reason string
```

Three of those were missing from an earlier version — described in three
documents, absent from the code, and untested. The engine was acting on data its
own estimator had labelled untrustworthy.

**That last one is the product.** If a plain-English explanation cannot be
generated, the change does not happen:

> Trend shows +0.11 lb/week, outside your target band of +0.25 to +0.50
> lb/week. Moving calories up 50 to 2600. Estimated expenditure 2450 kcal
> (2300-2600), medium confidence. Using 2500 kcal/lb for a gain phase, not 3500.
> Applying 60% of the computed correction, because a change takes about two
> weeks to show up.

And when calories are no longer a plausible explanation, it stops instead:

> Your intake has moved up 350 kcal across several cycles and the weight trend
> still has not responded. At this point the most likely explanations are no
> longer calories. Your plan lists a baseline blood panel as the highest-priority
> thing to rule out. Worth raising with a doctor before adding more food.

---

## System load

The training half of the engine. On bodyweight-loaded lifts — weighted pull-ups,
dips — the number that matters is not belt weight:

```ts
systemLoad = bodyweightOnSessionDate + addedWeight
```

+45 lb at 132 lb bodyweight and +45 lb at 142 lb are a 10 lb difference in real
work. During a deliberate lean gain, tracking belt weight alone makes genuine
progress look like a plateau — the single most common reason people abandon
these lifts mid-gain.

Bodyweight resolves to the most recent **prior** log entry, never a later one:
using a later reading would make historical system loads change retroactively
every time the user steps on a scale. When bodyweight is unknown the function
returns `null`, so the UI shows `—` rather than a number that reads as a stall.

---

## API

```ts
import {
  computeTrend, trendSlopePerDay, isWarmingUp,   // trend.ts
  estimateTdee, summariseTaggedIntake,            // tdee.ts
  adjustTarget,                                   // adjust.ts
  systemLoad, nextPrescription, isStalled,        // progression.ts
  detectDeload,                                   // deload.ts
  auditVolume,                                    // volume.ts
} from '@overload/engine';
```

Every function is pure. Every function that can fail to have an answer returns
`null` rather than a plausible-looking guess.

---

## Testing

Synthetic fixtures with a deterministic PRNG (never `Math.random()`), covering
the awkward cases: missing days, a sick week of water retention, a vacation, a
whoosh, a mid-series scale change, and 25-seed sweeps for anything with a
calibrated threshold.

Assumptions and derivations: [`docs/ALGORITHM.md`](../../docs/ALGORITHM.md).
Irreversible calls and their costs: [`docs/DECISIONS.md`](../../docs/DECISIONS.md).

MIT. Not medical advice.
