import { describe, expect, it } from 'vitest';
import { computeTrend } from '../src/trend.js';
import { ENERGY_DENSITY_PER_LB, estimateTdee, summariseTaggedIntake } from '../src/tdee.js';
import { makeIntake, makeWeights } from './fixtures/synthetic.js';

const START = '2026-08-01';
/** 90 days, so the EWMA has settled. See trendWarmupDays(). */
const DAYS = 90;
const TODAY = '2026-10-29'; // day 89

function scenario(opts: {
  lbPerWeek: number;
  meanKcal: number;
  intakeMissing?: number[];
  weightMissing?: number[];
  shiftBonusKcal?: number;
  days?: number;
}) {
  const days = opts.days ?? DAYS;
  return {
    trend: computeTrend(
      makeWeights({
        start: START,
        days,
        startWeightLb: 132.6,
        lbPerWeek: opts.lbPerWeek,
        ...(opts.weightMissing ? { missingDays: opts.weightMissing } : {}),
      }),
    ),
    intake: makeIntake({
      start: START,
      days,
      meanKcal: opts.meanKcal,
      ...(opts.intakeMissing ? { missingDays: opts.intakeMissing } : {}),
      ...(opts.shiftBonusKcal ? { shiftBonusKcal: opts.shiftBonusKcal } : {}),
    }),
  };
}

describe('ENERGY_DENSITY_PER_LB', () => {
  // Pinned to exact values. `toBeLessThan(3500)` would pass on {gain: 1},
  // so it pinned nothing despite three documents claiming it did.
  it('pins the gain constant, so nobody restores the textbook 3500', () => {
    expect(ENERGY_DENSITY_PER_LB.gain).toBe(2500);
  });

  it('pins the loss constant', () => {
    expect(ENERGY_DENSITY_PER_LB.loss).toBe(3200);
  });

  it('is higher for loss than for gain, since loss is fat-dominant', () => {
    expect(ENERGY_DENSITY_PER_LB.loss).toBeGreaterThan(ENERGY_DENSITY_PER_LB.gain);
  });
});

describe('estimateTdee', () => {
  it('returns null with no data rather than a fabricated number', () => {
    expect(estimateTdee({ today: TODAY, trend: [], intake: [], goalType: 'gain' })).toBeNull();
  });

  it('estimates maintenance when weight is flat', () => {
    const s = scenario({ lbPerWeek: 0, meanKcal: 2300 });
    const e = estimateTdee({ today: TODAY, ...s, goalType: 'gain' })!;
    expect(e.kcal).toBeGreaterThan(2100);
    expect(e.kcal).toBeLessThan(2500);
  });

  it('estimates above intake when gaining', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550 });
    const e = estimateTdee({ today: TODAY, ...s, goalType: 'gain' })!;
    expect(e.kcal).toBeLessThan(2550); // expenditure below intake => surplus
  });

  it('estimates above intake when losing', () => {
    const s = scenario({ lbPerWeek: -1, meanKcal: 2000 });
    const e = estimateTdee({ today: TODAY, ...s, goalType: 'loss' })!;
    expect(e.kcal).toBeGreaterThan(2000);
  });

  it('quantifies what a naive 3500 constant costs, in the right direction', () => {
    // A 3500 constant attributes MORE energy to each pound gained, so it
    // UNDERSTATES expenditure, which understates the target. The previous
    // version of this test was named backwards and asserted an algebraic
    // identity (kcal is monotonically decreasing in density for a positive
    // slope), so it would have passed on any two densities at all.
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550 });
    const correct = estimateTdee({ today: TODAY, ...s, goalType: 'gain' })!;
    const naive = estimateTdee(
      { today: TODAY, ...s, goalType: 'gain' },
      { energyDensityPerLb: 3500 },
    )!;
    const slope = correct.slopePerDay;
    // The gap is exactly slope * (3500 - 2500), which is ~57 kcal/day at
    // 0.4 lb/week — NOT the ~200 kcal/day the docs originally claimed.
    expect(correct.kcal - naive.kcal).toBeCloseTo(slope * 1000, -1.5);
    expect(correct.kcal - naive.kcal).toBeLessThan(120);
  });

  it('always reports a range, never a bare number', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550 });
    const e = estimateTdee({ today: TODAY, ...s, goalType: 'gain' })!;
    expect(e.low).toBeLessThan(e.kcal);
    expect(e.high).toBeGreaterThan(e.kcal);
  });

  it('caps confidence at low under 14 logged days', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550, days: 12 });
    const e = estimateTdee({ today: '2026-08-12', ...s, goalType: 'gain' }, { windowDays: 12 })!;
    expect(e.confidence).toBe('low');
  });

  it('caps confidence at low while the trend filter is still warming up', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550, days: 21 });
    const e = estimateTdee({ today: '2026-08-21', ...s, goalType: 'gain' }, { windowDays: 21 })!;
    expect(e.warmingUp).toBe(true);
    expect(e.confidence).toBe('low');
    expect(e.reason).toContain('settle');
  });

  it('actually understates the rate while warming up, and says so', () => {
    // The claim in the name is now asserted rather than merely commented.
    const short = scenario({ lbPerWeek: 0.4, meanKcal: 2550, days: 35 });
    const long = scenario({ lbPerWeek: 0.4, meanKcal: 2550, days: 90 });
    const a = estimateTdee({ today: '2026-09-04', ...short, goalType: 'gain' })!;
    const b = estimateTdee({ today: TODAY, ...long, goalType: 'gain' })!;

    expect(a.warmingUp).toBe(true);
    expect(a.confidence).toBe('low');
    expect(a.slopePerDay).toBeLessThan(b.slopePerDay);
    expect(b.warmingUp).toBe(false);
    expect(b.slopePerDay * 7).toBeCloseTo(0.4, 1);
  });

  it('does not trust a dense-looking trend built from sparse weigh-ins', () => {
    // computeTrend carries forward across gaps, so the series is always dense.
    // Weekly weigh-ins regressed as if daily read ~38% low at high confidence.
    const weekly = Array.from({ length: 90 }, (_, i) => i).filter((i) => i % 7 !== 0);
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550, weightMissing: weekly });
    const e = estimateTdee({ today: TODAY, ...s, goalType: 'gain' })!;
    expect(e.weighInCoverage).toBeLessThan(0.5);
    expect(e.confidence).toBe('low');
  });

  it('does not trust an estimate whose last weigh-in is stale', () => {
    const stale = Array.from({ length: 18 }, (_, i) => 89 - i);
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550, weightMissing: stale });
    const e = estimateTdee({ today: TODAY, ...s, goalType: 'gain' })!;
    expect(e.weighInStalenessDays).toBeGreaterThan(3);
    expect(e.confidence).toBe('low');
  });

  it('rejects a non-finite weight instead of poisoning every number downstream', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550 });
    const bad = makeWeights({ start: START, days: 90, startWeightLb: 132.6, lbPerWeek: 0.4 });
    bad[40]!.weightLb = NaN;
    expect(() => computeTrend(bad)).toThrow(RangeError);
    expect(s.trend.every((p) => Number.isFinite(p.trend))).toBe(true);
  });

  it('sums multiple intake entries per day rather than averaging them', () => {
    // meanIntake was a per-ENTRY mean while loggedDays counted DATES, so a
    // user logging four meal rows a day had their intake divided by four.
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550 });
    const split = s.intake.flatMap((e) => [
      { ...e, id: `${e.id}a`, calories: e.calories / 4 },
      { ...e, id: `${e.id}b`, calories: e.calories / 4 },
      { ...e, id: `${e.id}c`, calories: e.calories / 4 },
      { ...e, id: `${e.id}d`, calories: e.calories / 4 },
    ]);
    const whole = estimateTdee({ today: TODAY, ...s, goalType: 'gain' })!;
    const meals = estimateTdee({ today: TODAY, trend: s.trend, intake: split, goalType: 'gain' })!;
    expect(meals.kcal).toBe(whole.kcal);
    expect(meals.loggedDays).toBe(whole.loggedDays);
  });

  it('caps confidence at low below 70% coverage', () => {
    const missing = Array.from({ length: 14 }, (_, i) => i + 68);
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550, intakeMissing: missing });
    const e = estimateTdee({ today: TODAY, ...s, goalType: 'gain' }, { windowDays: 28 })!;
    expect(e.coverage).toBeLessThan(0.7);
    expect(e.confidence).toBe('low');
  });

  it('reaches high confidence on consistent near-daily logging', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550 });
    const e = estimateTdee({ today: TODAY, ...s, goalType: 'gain' })!;
    expect(e.confidence).toBe('high');
  });

  it('explains its confidence in words', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550 });
    expect(estimateTdee({ today: TODAY, ...s, goalType: 'gain' })!.reason.length).toBeGreaterThan(0);
  });

  it('tolerates missing weigh-in days', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550, weightMissing: [10, 11, 12, 25, 26] });
    expect(estimateTdee({ today: TODAY, ...s, goalType: 'gain' })).not.toBeNull();
  });

  it('recovers the true rate to within 0.1 lb/week on settled data', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550 });
    const e = estimateTdee({ today: TODAY, ...s, goalType: 'gain' })!;
    expect(Math.abs(e.slopePerDay * 7 - 0.4)).toBeLessThan(0.1);
  });
});

describe('summariseTaggedIntake', () => {
  it('returns null until both day types have enough days', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550, days: 10 });
    expect(summariseTaggedIntake(s.intake, '2026-08-10', 10)).toBeNull();
  });

  it('reports the intake difference it actually measured', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550, shiftBonusKcal: 350 });
    const t = summariseTaggedIntake(s.intake, TODAY)!;
    expect(t.deltaKcal).toBeGreaterThan(250);
    expect(t.meanShiftKcal).toBeGreaterThan(t.meanOffKcal);
  });

  it('reports a NEGATIVE delta when the user eats less on shift days', () => {
    // The regression this guards: clamping to [0, 600] censored the
    // disconfirming direction, so the common retail case - busier and eating
    // LESS on shift days - was reported as "no difference, that is fine".
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550, shiftBonusKcal: -350 });
    const t = summariseTaggedIntake(s.intake, TODAY)!;
    expect(t.deltaKcal).toBeLessThan(-250);
    expect(t.isSignificant).toBe(true);
    expect(t.reason).toContain('LESS');
  });

  it('does not claim a flat intake means expenditure is flat', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550 });
    const t = summariseTaggedIntake(s.intake, TODAY)!;
    expect(t.isSignificant).toBe(false);
    expect(t.reason).toContain('300-500');
    expect(t.reason.toLowerCase()).not.toContain('is fine');
  });

  it('calls a small difference noise rather than a pattern', () => {
    // Guards a fixed 50 kcal cutoff: with sd ~200 over ~20 days per tag the
    // sampling margin alone is ~120 kcal, so a fixed cutoff would report pure
    // noise as a real finding most of the time.
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550, shiftBonusKcal: 60 });
    const t = summariseTaggedIntake(s.intake, TODAY)!;
    expect(t.marginKcal).toBeGreaterThan(60);
    expect(t.isSignificant).toBe(false);
    expect(t.reason).toContain('ordinary day-to-day variation');
  });

  it('reports a large difference as significant', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550, shiftBonusKcal: 350 });
    const t = summariseTaggedIntake(s.intake, TODAY)!;
    expect(t.isSignificant).toBe(true);
    expect(Math.abs(t.deltaKcal)).toBeGreaterThan(t.marginKcal);
  });

  it('describes intake and never claims to measure expenditure', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550, shiftBonusKcal: 350 });
    const t = summariseTaggedIntake(s.intake, TODAY)!;
    expect(t).not.toHaveProperty('shift');
    expect(t).not.toHaveProperty('off');
    expect(t.reason).toContain('not your expenditure');
  });

  it('sums multiple entries per day before comparing', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550 });
    const split = s.intake.flatMap((e, i) => [
      { ...e, id: `${e.id}a`, calories: e.calories / 2 },
      { ...e, id: `${e.id}b`, calories: e.calories / 2 },
    ]);
    const whole = summariseTaggedIntake(s.intake, TODAY)!;
    const halved = summariseTaggedIntake(split, TODAY)!;
    expect(halved.meanShiftKcal).toBeCloseTo(whole.meanShiftKcal, 0);
  });
});
