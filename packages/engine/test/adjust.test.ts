/**
 * Guardrail tests. The spec says to write these BEFORE the feature, because a
 * calorie engine that acts on thin data is worse than no calorie engine.
 *
 * An earlier version of this file did not test `warmingUp` or `confidence` at
 * all — which is exactly why neither guardrail existed in the code while three
 * documents claimed it did.
 */
import { describe, expect, it } from 'vitest';
import { adjustTarget, DEFAULT_ADJUST_OPTIONS, type AdjustInputs } from '../src/adjust.js';
import type { TdeeEstimate } from '../src/tdee.js';

const estimate = (over: Partial<TdeeEstimate> = {}): TdeeEstimate => ({
  kcal: 2450,
  low: 2300,
  high: 2600,
  confidence: 'high',
  loggedDays: 26,
  weighInDays: 26,
  windowDays: 28,
  coverage: 26 / 28,
  weighInCoverage: 26 / 28,
  weighInStalenessDays: 0,
  slopePerDay: 0.4 / 7,
  energyDensityPerLb: 2500,
  warmingUp: false,
  reason: 'test',
  ...over,
});

const base: AdjustInputs = {
  today: '2026-09-11',
  profile: {
    goalType: 'gain',
    targetRateBandLbPerWeek: [0.25, 0.5],
    caloriesLocked: false,
  },
  currentTarget: 2550,
  estimate: estimate(),
  inDeloadWeek: false,
};

/** Well outside the band on the low side, so an adjustment is warranted. */
const gainingTooSlowly = { slopePerDay: 0.05 / 7 };
/** Well outside the band on the high side. */
const gainingTooFast = { slopePerDay: 1.2 / 7 };

describe('data-sufficiency guardrails', () => {
  it('blocks while the trend filter is warming up', () => {
    const r = adjustTarget({
      ...base,
      estimate: estimate({ ...gainingTooSlowly, warmingUp: true }),
    });
    expect(r.changed).toBe(false);
    expect(r.blockedBy).toBe('warming-up');
  });

  it('the warm-up block is what prevents the month-one overfeeding trap', () => {
    // Warming up understates the gain rate, which reads as "not gaining fast
    // enough". Without this block the engine adds calories in exactly the
    // period where it is least able to tell whether they are needed.
    const r = adjustTarget({
      ...base,
      estimate: estimate({ slopePerDay: 0.05 / 7, warmingUp: true, confidence: 'low' }),
    });
    expect(r.deltaKcal).toBe(0);
    expect(r.newTarget).toBe(base.currentTarget);
  });

  it('blocks on low confidence', () => {
    const r = adjustTarget({
      ...base,
      estimate: estimate({ ...gainingTooSlowly, confidence: 'low' }),
    });
    expect(r.blockedBy).toBe('low-confidence');
  });

  it('acts on medium confidence', () => {
    const r = adjustTarget({
      ...base,
      estimate: estimate({ ...gainingTooSlowly, confidence: 'medium' }),
    });
    expect(r.changed).toBe(true);
  });

  it('blocks with fewer than 14 logged days in the window', () => {
    const r = adjustTarget({
      ...base,
      estimate: estimate({ ...gainingTooSlowly, loggedDays: 12 }),
    });
    expect(r.blockedBy).toBe('insufficient-logged-days');
  });

  it('blocks below 70% coverage', () => {
    const r = adjustTarget({
      ...base,
      estimate: estimate({ ...gainingTooSlowly, loggedDays: 16, coverage: 0.5 }),
    });
    expect(r.blockedBy).toBe('insufficient-coverage');
  });

  it('blocks a second adjustment inside 14 days', () => {
    const r = adjustTarget({
      ...base,
      estimate: estimate(gainingTooSlowly),
      lastAdjustmentDate: '2026-09-04',
    });
    expect(r.blockedBy).toBe('too-soon');
  });

  it('allows an adjustment at exactly 14 days', () => {
    const r = adjustTarget({
      ...base,
      estimate: estimate(gainingTooSlowly),
      lastAdjustmentDate: '2026-08-28',
    });
    expect(r.blockedBy).not.toBe('too-soon');
  });

  it('does not let a future-dated last adjustment bypass the cooldown', () => {
    // `since >= 0 && since < limit` used to skip the guard entirely when the
    // date was in the future. A bad import should not disable a safety check.
    const r = adjustTarget({
      ...base,
      estimate: estimate(gainingTooSlowly),
      lastAdjustmentDate: '2026-09-20',
    });
    expect(r.blockedBy).toBe('too-soon');
  });

  it('rejects a non-finite slope instead of writing NaN to the target', () => {
    const r = adjustTarget({ ...base, estimate: estimate({ slopePerDay: NaN }) });
    expect(r.changed).toBe(false);
    expect(Number.isFinite(r.newTarget)).toBe(true);
  });
});

describe('deload and lock guardrails', () => {
  it('blocks during a deload week', () => {
    const r = adjustTarget({
      ...base,
      estimate: estimate(gainingTooSlowly),
      inDeloadWeek: true,
    });
    expect(r.blockedBy).toBe('deload-cooldown');
    expect(r.reason.toLowerCase()).toContain('deload');
  });

  it('blocks within 3 days after a deload week', () => {
    const r = adjustTarget({
      ...base,
      estimate: estimate(gainingTooSlowly),
      lastDeloadEndDate: '2026-09-09',
    });
    expect(r.blockedBy).toBe('deload-cooldown');
  });

  it('does not let a future-dated deload end bypass the cooldown', () => {
    const r = adjustTarget({
      ...base,
      estimate: estimate(gainingTooSlowly),
      lastDeloadEndDate: '2026-09-20',
    });
    expect(r.blockedBy).toBe('deload-cooldown');
  });

  it('blocks when calories are locked, above every other consideration', () => {
    const r = adjustTarget({
      ...base,
      profile: { ...base.profile, caloriesLocked: true },
      estimate: estimate(gainingTooSlowly),
    });
    expect(r.blockedBy).toBe('calories-locked');
  });
});

describe('the target band', () => {
  it('does nothing while the observed rate is inside the band', () => {
    const r = adjustTarget({ ...base, estimate: estimate({ slopePerDay: 0.35 / 7 }) });
    expect(r.changed).toBe(false);
    expect(r.blockedBy).toBe('in-target-band');
  });

  it('does nothing at either edge of the band', () => {
    for (const rate of [0.25, 0.5]) {
      const r = adjustTarget({ ...base, estimate: estimate({ slopePerDay: rate / 7 }) });
      expect(r.changed, `rate ${rate}`).toBe(false);
    }
  });

  it('tolerates ordinary week-to-week variation without adjusting', () => {
    // The regression this guards: a scalar target plus a 25 kcal rounding step
    // made the real deadband 0.035 lb/week, so the engine adjusted nearly every
    // cycle, usually at the +/-100 cap.
    const rates = [0.26, 0.3, 0.34, 0.38, 0.42, 0.46, 0.49];
    for (const rate of rates) {
      const r = adjustTarget({ ...base, estimate: estimate({ slopePerDay: rate / 7 }) });
      expect(r.changed, `rate ${rate}`).toBe(false);
    }
  });

  it('raises calories when gaining more slowly than the band', () => {
    const r = adjustTarget({ ...base, estimate: estimate(gainingTooSlowly) });
    expect(r.changed).toBe(true);
    expect(r.deltaKcal).toBeGreaterThan(0);
  });

  it('lowers calories when gaining faster than the band', () => {
    const r = adjustTarget({ ...base, estimate: estimate(gainingTooFast) });
    expect(r.changed).toBe(true);
    expect(r.deltaKcal).toBeLessThan(0);
  });

  it('corrects toward the nearest band edge, not the midpoint', () => {
    // Overshooting to the middle guarantees crossing the band half the time.
    const r = adjustTarget({ ...base, estimate: estimate({ slopePerDay: 0.15 / 7 }) });
    const toEdge = ((0.25 - 0.15) * 2500) / 7;
    expect(Math.abs(r.deltaKcal)).toBeLessThanOrEqual(
      Math.abs(toEdge * DEFAULT_ADJUST_OPTIONS.damping) + 25,
    );
  });

  it('works on a loss phase, where the band is negative', () => {
    const r = adjustTarget({
      ...base,
      profile: { ...base.profile, goalType: 'loss', targetRateBandLbPerWeek: [-1, -0.5] },
      currentTarget: 2200,
      estimate: estimate({ slopePerDay: -0.1 / 7, energyDensityPerLb: 3200 }),
    });
    // Losing too slowly on a loss phase means cutting calories.
    expect(r.changed).toBe(true);
    expect(r.deltaKcal).toBeLessThan(0);
  });
});

describe('magnitude, damping and rounding', () => {
  it('never changes by more than 100 kcal', () => {
    const r = adjustTarget({ ...base, estimate: estimate({ slopePerDay: -1 }) });
    expect(Math.abs(r.deltaKcal)).toBeLessThanOrEqual(100);
  });

  it('applies only a fraction of the computed correction', () => {
    const rate = 0.05;
    const r = adjustTarget({ ...base, estimate: estimate({ slopePerDay: rate / 7 }) });
    const undamped = ((0.25 - rate) * 2500) / 7;
    expect(Math.abs(r.deltaKcal)).toBeLessThan(Math.abs(undamped));
    expect(r.reason).toContain('%');
  });

  it('treats a sub-25 kcal correction as zero rather than rounding it up', () => {
    // Math.round(x/25)*25 amplified a 13 kcal correction into a 25 kcal change,
    // which is the opposite of a deadband.
    const rate = 0.25 - 0.05; // needs ~18 kcal before damping, ~11 after
    const r = adjustTarget({ ...base, estimate: estimate({ slopePerDay: rate / 7 }) });
    expect(r.deltaKcal).toBe(0);
  });

  it('rounds every change to a 25 kcal step', () => {
    for (const rate of [0, 0.05, 0.1, 0.9, 1.5]) {
      const r = adjustTarget({ ...base, estimate: estimate({ slopePerDay: rate / 7 }) });
      expect(Math.abs(r.deltaKcal % 25), `rate ${rate}`).toBe(0);
    }
  });
});

describe('floors and ceilings', () => {
  it('never pushes the target below the absolute floor', () => {
    const r = adjustTarget({
      ...base,
      currentTarget: 1650,
      profile: { ...base.profile, goalType: 'loss', targetRateBandLbPerWeek: [-2, -1.5] },
      estimate: estimate({ slopePerDay: 0, energyDensityPerLb: 3200, low: 1400, kcal: 1550 }),
    });
    expect(r.blockedBy).toBe('floor-reached');
    expect(r.newTarget).toBe(1650);
  });

  it('cannot ratchet below the floor across repeated cycles', () => {
    // The scenario the floor exists for: creatine + carb loading adds water
    // that reads as fast gain, and the engine cuts repeatedly for a change
    // that was never tissue.
    let target = 2550;
    let date = '2026-09-11';
    for (let i = 0; i < 40; i++) {
      const r = adjustTarget({
        ...base,
        today: date,
        currentTarget: target,
        estimate: estimate({ slopePerDay: 1.2 / 7, low: 1200 }),
      });
      if (!r.changed) break;
      target = r.newTarget;
      date = `2026-${String(9 + Math.floor(i / 2)).padStart(2, '0')}-11`;
    }
    expect(target).toBeGreaterThanOrEqual(DEFAULT_ADJUST_OPTIONS.minTargetKcal);
  });

  it('refuses to drop a gain-phase target below its own estimated expenditure', () => {
    const r = adjustTarget({
      ...base,
      currentTarget: 2350,
      estimate: estimate({ slopePerDay: 1.5 / 7, low: 2300 }),
    });
    expect(r.blockedBy).toBe('floor-reached');
  });

  it('honours a per-user floor override', () => {
    const r = adjustTarget({
      ...base,
      currentTarget: 2000,
      profile: {
        ...base.profile,
        goalType: 'loss',
        targetRateBandLbPerWeek: [-2, -1.5],
        minTargetKcal: 1950,
      },
      estimate: estimate({ slopePerDay: 0, energyDensityPerLb: 3200, low: 1500 }),
    });
    expect(r.blockedBy).toBe('floor-reached');
  });
});

describe('escalation beyond calories', () => {
  it('stops adjusting and points at a medical screen when food is not the answer', () => {
    // A verified surplus with no trend response for weeks is close to the
    // textbook presentation of the causes the plan lists as highest priority.
    // The engine's only vocabulary used to be "add 100 more".
    const r = adjustTarget({
      ...base,
      baselineTarget: 2550,
      currentTarget: 2900,
      consecutiveUnresponsiveAdjustments: 4,
      estimate: estimate({ slopePerDay: 0 }),
    });
    expect(r.changed).toBe(false);
    expect(r.blockedBy).toBe('needs-review');
    expect(r.needsReview).toBe(true);
    expect(r.reason.toLowerCase()).toContain('doctor');
  });

  it('does not escalate while drift is still small', () => {
    const r = adjustTarget({
      ...base,
      baselineTarget: 2550,
      currentTarget: 2600,
      consecutiveUnresponsiveAdjustments: 4,
      estimate: estimate({ slopePerDay: 0 }),
    });
    expect(r.blockedBy).not.toBe('needs-review');
  });

  it('does not escalate on a single unresponsive cycle', () => {
    const r = adjustTarget({
      ...base,
      baselineTarget: 2550,
      currentTarget: 2900,
      consecutiveUnresponsiveAdjustments: 1,
      estimate: estimate({ slopePerDay: 0 }),
    });
    expect(r.blockedBy).not.toBe('needs-review');
  });
});

describe('reason strings', () => {
  it('always populates a reason, blocked or not', () => {
    const cases: AdjustInputs[] = [
      base,
      { ...base, inDeloadWeek: true },
      { ...base, estimate: estimate({ loggedDays: 2 }) },
      { ...base, estimate: estimate({ warmingUp: true }) },
      { ...base, estimate: estimate({ slopePerDay: -1 }) },
      { ...base, profile: { ...base.profile, caloriesLocked: true } },
    ];
    for (const c of cases) expect(adjustTarget(c).reason.length).toBeGreaterThan(0);
  });

  it('names the energy density it used, so the number is auditable', () => {
    const r = adjustTarget({ ...base, estimate: estimate(gainingTooSlowly) });
    expect(r.reason).toContain('2500');
    expect(r.reason).toContain('not 3500');
  });

  it('carries the confidence through to the decision', () => {
    const r = adjustTarget({ ...base, estimate: estimate({ confidence: 'medium' }) });
    expect(r.confidence).toBe('medium');
  });

  it('does not say "gaining" on a loss phase', () => {
    const r = adjustTarget({
      ...base,
      profile: { ...base.profile, goalType: 'loss', targetRateBandLbPerWeek: [-1, -0.5] },
      estimate: estimate({ slopePerDay: -0.75 / 7 }),
    });
    expect(r.reason.toLowerCase()).not.toContain('gaining');
  });
});
