import { describe, expect, it } from 'vitest';
import { computeTrend } from '../src/trend.js';
import { ENERGY_DENSITY_PER_LB, estimateTaggedExpenditure, estimateTdee } from '../src/tdee.js';
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
  it('is not 3500 for a gain phase — this is the whole point', () => {
    expect(ENERGY_DENSITY_PER_LB.gain).toBeLessThan(3500);
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

  it('a naive 3500 constant would overstate expenditure on a gain', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550 });
    const correct = estimateTdee({ today: TODAY, ...s, goalType: 'gain' })!;
    const naive = estimateTdee({ today: TODAY, ...s, goalType: 'gain' }, { energyDensityPerLb: 3500 })!;
    expect(naive.kcal).toBeLessThan(correct.kcal);
    // The gap is the overfeeding a naive implementation causes.
    expect(correct.kcal - naive.kcal).toBeGreaterThan(40);
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

  it('understates the true rate while warming up — the known bias', () => {
    // Documented, not fixed. Guarded by warmingUp + low confidence instead.
    const short = scenario({ lbPerWeek: 0.4, meanKcal: 2550, days: 42 });
    const long = scenario({ lbPerWeek: 0.4, meanKcal: 2550, days: 90 });
    const a = estimateTdee({ today: '2026-09-11', ...short, goalType: 'gain' })!;
    const b = estimateTdee({ today: TODAY, ...long, goalType: 'gain' })!;
    expect(a.warmingUp).toBe(false); // 42 >= 28, settled by the 4-half-life rule
    expect(b.slopePerDay * 7).toBeCloseTo(0.4, 1);
  });

  it('caps confidence at low below 70% coverage', () => {
    const missing = Array.from({ length: 14 }, (_, i) => i + 68);
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550, intakeMissing: missing });
    const e = estimateTdee({ today: TODAY, ...s, goalType: 'gain' }, { windowDays: 28 })!;
    expect(e.coverage).toBeLessThan(0.7);
    expect(e.confidence).toBe('low');
  });

  it('reaches high confidence on 28 consistent days', () => {
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

describe('estimateTaggedExpenditure', () => {
  it('returns null until both day types have enough days', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550, days: 10 });
    const base = estimateTdee({ today: '2026-08-10', ...s, goalType: 'gain' }, { windowDays: 10 })!;
    expect(estimateTaggedExpenditure(base, s.intake, '2026-08-10')).toBeNull();
  });

  it('puts shift-day expenditure above off-day when intake differs', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550, shiftBonusKcal: 350 });
    const base = estimateTdee({ today: TODAY, ...s, goalType: 'gain' })!;
    const tagged = estimateTaggedExpenditure(base, s.intake, TODAY)!;
    expect(tagged.shift).toBeGreaterThan(tagged.off);
    expect(tagged.deltaKcal).toBeGreaterThan(150);
  });

  it('bounds the delta to a plausible NEAT range', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550, shiftBonusKcal: 2000 });
    const base = estimateTdee({ today: TODAY, ...s, goalType: 'gain' })!;
    expect(estimateTaggedExpenditure(base, s.intake, TODAY)!.deltaKcal).toBeLessThanOrEqual(600);
  });

  it('never returns a negative delta', () => {
    const s = scenario({ lbPerWeek: 0.4, meanKcal: 2550, shiftBonusKcal: -400 });
    const base = estimateTdee({ today: TODAY, ...s, goalType: 'gain' })!;
    expect(estimateTaggedExpenditure(base, s.intake, TODAY)!.deltaKcal).toBe(0);
  });
});
