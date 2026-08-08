# @overload/engine

An adaptive body-composition engine that explains every number it produces.

Pure TypeScript. One runtime dependency (Zod). No browser, no network, no
storage layer, no framework. Everything here is a function from data to a
decision plus a human-readable reason for it.

```bash
npm test        # 108 tests
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

A 3500 constant prescribes roughly **200 kcal/day more than needed**. Over six
months that is several pounds of avoidable fat, produced by a tool the user
trusted.

There is a test asserting the gain constant stays below 3500, purely so nobody
later "corrects" it back to the textbook number.

### 2. The estimator is biased early, and says so

An EWMA seeded from a short mean lags a real trend while it catches up, so the
slope is biased toward zero for the first ~8 weeks. Measured on synthetic data
at a true 0.4 lb/week gain:

| History | Recovered rate | Error |
|---|---|---|
| 42 days | 0.24-0.37 lb/wk | up to 40% low |
| 60 days | 0.39 lb/wk | ~3% low |
| 90 days | 0.38-0.40 lb/wk | <5% |

An understated gain rate reads as "not gaining fast enough", and the naive
response is to add calories — precisely backwards during month one.

The engine does not correct this. It detects it (`warmingUp`), caps confidence
at `low`, and lets the guardrails prevent action. Saying *I do not know yet* is
a feature.

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
No adjustment while the trend filter is warming up (< 28 days history)
No adjustment with a window shorter than 14 days
No adjustment with fewer than 10 logged days in the window
Maximum ±100 kcal per adjustment
Maximum one adjustment per 7 days
No adjustment during, or within 3 days after, a deload week
No adjustment if the user has locked calories
Changes below 25 kcal are treated as zero
Every adjustment stores a human-readable reason string
```

**That last one is the product.** If a plain-English explanation cannot be
generated, the change does not happen:

> Trend shows +0.11 lb/week against a target of +0.40 lb/week. Moving calories
> up 100 to 2650. Estimated expenditure 2450 kcal (2350-2550), medium
> confidence. Using 2500 kcal/lb for a gain phase, not 3500.

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
  estimateTdee, estimateTaggedExpenditure,        // tdee.ts
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
