import { describe, expect, it } from 'vitest';
import {
  alphaFromHalfLife,
  computeTrend,
  isWarmingUp,
  mad,
  trendSlopePerDay,
  trendWarmupDays,
} from '../src/trend.js';
import { makeWeights } from './fixtures/synthetic.js';
import type { WeightEntry } from '../src/types.js';

const entry = (date: string, weightLb: number): WeightEntry => ({
  id: date,
  date,
  weightLb,
  source: 'manual',
  flaggedOutlier: false,
});

describe('alphaFromHalfLife', () => {
  it('matches the documented value at a 7-day half-life', () => {
    expect(alphaFromHalfLife(7)).toBeCloseTo(0.0943, 4);
  });

  it('rejects a non-positive half-life', () => {
    expect(() => alphaFromHalfLife(0)).toThrow(RangeError);
  });
});

describe('mad', () => {
  it('is zero for a constant series', () => {
    expect(mad([5, 5, 5, 5])).toBe(0);
  });

  it('is scaled so one MAD approximates one sd on normal data', () => {
    // For [1..9] the raw MAD is 2, scaled 2 * 1.4826.
    expect(mad([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBeCloseTo(2.9652, 3);
  });
});

describe('computeTrend', () => {
  it('returns an empty series for no entries', () => {
    expect(computeTrend([])).toEqual([]);
  });

  it('seeds from the mean of the first three readings, not the first', () => {
    const series = computeTrend([
      entry('2026-08-01', 130),
      entry('2026-08-02', 134),
      entry('2026-08-03', 132),
    ]);
    // Seed is 132. First point applies alpha to a raw of 130 against that seed.
    const alpha = alphaFromHalfLife(7);
    expect(series[0]!.trend).toBeCloseTo(alpha * 130 + (1 - alpha) * 132, 6);
  });

  it('carries the trend forward on missing days without inventing a reading', () => {
    const series = computeTrend([
      entry('2026-08-01', 132),
      entry('2026-08-02', 132),
      entry('2026-08-05', 133),
    ]);
    expect(series).toHaveLength(5);
    expect(series[2]!.raw).toBeNull();
    expect(series[3]!.raw).toBeNull();
    expect(series[2]!.trend).toBe(series[1]!.trend);
  });

  it('de-duplicates by date with last write winning, and accepts unsorted input', () => {
    const series = computeTrend([
      entry('2026-08-03', 133),
      entry('2026-08-01', 130),
      entry('2026-08-01', 131),
    ]);
    expect(series).toHaveLength(3);
    expect(series[0]!.raw).toBe(131);
  });

  it('flags an outlier and downweights rather than deleting it', () => {
    const base = Array.from({ length: 10 }, (_, i) =>
      entry(`2026-08-${String(i + 1).padStart(2, '0')}`, 132 + (i % 2 ? 0.2 : -0.2)),
    );
    const spike = entry('2026-08-11', 145);
    const series = computeTrend([...base, spike]);
    const last = series[series.length - 1]!;

    expect(last.flaggedOutlier).toBe(true);
    expect(last.raw).toBe(145); // still present, not deleted
    // Downweighted: the trend moves less than a full-alpha update would.
    const alpha = alphaFromHalfLife(7);
    const full = alpha * 145 + (1 - alpha) * series[series.length - 2]!.trend;
    expect(last.trend).toBeLessThan(full);
  });

  it('does not flag anything before it has enough readings to judge', () => {
    const series = computeTrend([
      entry('2026-08-01', 132),
      entry('2026-08-02', 132),
      entry('2026-08-03', 145),
    ]);
    expect(series.every((p) => !p.flaggedOutlier)).toBe(true);
  });

  it('does not manufacture outliers from ordinary scale noise', () => {
    // The regression this guards: measuring against a trailing MEDIAN inside a
    // real trend flagged ~12% of normal readings. Against the trend it should
    // be a couple of percent at most on 90 days of realistic noise.
    const series = computeTrend(
      makeWeights({
        start: '2026-08-01',
        days: 90,
        startWeightLb: 132.6,
        lbPerWeek: 0.4,
        noiseSd: 0.7,
      }),
    );
    const flagged = series.filter((p) => p.flaggedOutlier).length;
    expect(flagged / series.length).toBeLessThan(0.03);
  });

  it('keeps the false-flag rate low across many seeds, not just one', () => {
    // A single lucky seed proves nothing. This is the test that would have
    // caught the original 3-MAD-against-median calibration.
    const rates = Array.from({ length: 25 }, (_, seed) => {
      const series = computeTrend(
        makeWeights({
          start: '2026-08-01',
          days: 90,
          startWeightLb: 132.6,
          lbPerWeek: 0.4,
          noiseSd: 0.8,
          seed,
        }),
      );
      return series.filter((p) => p.flaggedOutlier).length / series.length;
    });
    const worst = Math.max(...rates);
    const meanRate = rates.reduce((a, b) => a + b, 0) / rates.length;
    expect(meanRate, `mean ${meanRate}`).toBeLessThan(0.02);
    expect(worst, `worst ${worst}`).toBeLessThan(0.06);
  });

  it('catches a genuine bad reading across many seeds', () => {
    for (let seed = 0; seed < 25; seed++) {
      const weights = makeWeights({
        start: '2026-08-01',
        days: 60,
        startWeightLb: 132.6,
        lbPerWeek: 0.4,
        noiseSd: 0.8,
        seed,
      });
      weights[45]!.weightLb += 6; // a clothed weigh-in
      const series = computeTrend(weights);
      const point = series.find((p) => p.date === weights[45]!.date)!;
      expect(point.flaggedOutlier, `seed ${seed}`).toBe(true);
    }
  });

  it('still catches a genuine bad reading inside a noisy series', () => {
    const weights = makeWeights({
      start: '2026-08-01',
      days: 40,
      startWeightLb: 132.6,
      lbPerWeek: 0.4,
      noiseSd: 0.7,
    });
    weights[30]!.weightLb = 148; // clothed, or a different scale
    const series = computeTrend(weights);
    expect(series.find((p) => p.raw === 148)!.flaggedOutlier).toBe(true);
  });

  it('does not flag on a series that is unnaturally tight', () => {
    // Without a scale floor, a run of identical readings makes the MAD zero and
    // the next 0.2 lb wobble looks infinitely extreme.
    const flat = Array.from({ length: 12 }, (_, i) =>
      entry(`2026-08-${String(i + 1).padStart(2, '0')}`, 132.0),
    );
    const series = computeTrend([...flat, entry('2026-08-13', 132.4)]);
    expect(series[series.length - 1]!.flaggedOutlier).toBe(false);
  });
});

describe('warm-up', () => {
  it('reports eight half-lives as the settling period', () => {
    // Four half-lives (28 days) released the gate at the point of MAXIMUM
    // bias (-31%). The bias falls under 5% around 56 days.
    expect(trendWarmupDays(7)).toBe(56);
  });

  it('is warming up at four weeks, where the bias is worst', () => {
    const series = computeTrend(
      makeWeights({ start: '2026-08-01', days: 28, startWeightLb: 132.6, lbPerWeek: 0.4 }),
    );
    expect(isWarmingUp(series)).toBe(true);
  });

  it('has settled by nine weeks', () => {
    const series = computeTrend(
      makeWeights({ start: '2026-08-01', days: 63, startWeightLb: 132.6, lbPerWeek: 0.4 }),
    );
    expect(isWarmingUp(series)).toBe(false);
    expect(trendSlopePerDay(series, 28)! * 7).toBeCloseTo(0.4, 1);
  });

  it('does not call a sparse series settled just because it spans enough days', () => {
    // Two readings 60 days apart produce a 61-point carried-forward series.
    const series = computeTrend([
      { id: 'a', date: '2026-08-01', weightLb: 132, source: 'manual', flaggedOutlier: false },
      { id: 'b', date: '2026-09-30', weightLb: 136, source: 'manual', flaggedOutlier: false },
    ]);
    expect(series.length).toBeGreaterThan(56);
    expect(isWarmingUp(series)).toBe(true);
  });

  it('measures the documented warm-up bias, so the doc table stays honest', () => {
    const rate = (days: number) => {
      const slopes = Array.from({ length: 15 }, (_, seed) => {
        const s = computeTrend(
          makeWeights({
            start: '2026-08-01',
            days,
            startWeightLb: 132.6,
            lbPerWeek: 0.4,
            noiseSd: 0.8,
            seed,
          }),
        );
        return trendSlopePerDay(s, 28)! * 7;
      });
      return slopes.reduce((a, b) => a + b, 0) / slopes.length;
    };
    expect(rate(28)).toBeLessThan(0.33); // heavily biased where the old gate opened
    expect(Math.abs(rate(56) - 0.4)).toBeLessThan(0.06); // settled where it opens now
  });

  it('recovers the true rate on a clean 8-week gain', () => {
    const weights = makeWeights({
      start: '2026-08-01',
      days: 56,
      startWeightLb: 132.6,
      lbPerWeek: 0.4,
    });
    const series = computeTrend(weights);
    const slope = trendSlopePerDay(series, 28)!;
    expect(slope * 7).toBeCloseTo(0.4, 1);
  });

  it('is not derailed by a sick week of water retention', () => {
    const weights = makeWeights({
      start: '2026-08-01',
      days: 56,
      startWeightLb: 132.6,
      lbPerWeek: 0.4,
      waterBump: { from: 20, to: 26, lb: 3 },
    });
    const series = computeTrend(weights);
    const slope = trendSlopePerDay(series, 28)!;
    // The bump is transient and outside the trailing window by day 56.
    expect(slope * 7).toBeGreaterThan(0.1);
    expect(slope * 7).toBeLessThan(0.9);
  });

  it('survives a scale change without producing a nonsense rate', () => {
    const weights = makeWeights({
      start: '2026-08-01',
      days: 56,
      startWeightLb: 132.6,
      lbPerWeek: 0.4,
      scaleChangeDay: 28,
      scaleChangeLb: 1.5,
    });
    const series = computeTrend(weights);
    const slope = trendSlopePerDay(series, 28)!;
    // A step change inflates the apparent rate but must stay physiological.
    expect(Math.abs(slope * 7)).toBeLessThan(2);
  });
});

describe('trendSlopePerDay', () => {
  it('returns null below seven points', () => {
    const series = computeTrend([entry('2026-08-01', 132), entry('2026-08-02', 133)]);
    expect(trendSlopePerDay(series, 28)).toBeNull();
  });

  it('is positive on a gain and negative on a loss', () => {
    const gain = computeTrend(
      makeWeights({ start: '2026-08-01', days: 42, startWeightLb: 132, lbPerWeek: 0.5 }),
    );
    const loss = computeTrend(
      makeWeights({ start: '2026-08-01', days: 42, startWeightLb: 160, lbPerWeek: -1 }),
    );
    expect(trendSlopePerDay(gain, 28)!).toBeGreaterThan(0);
    expect(trendSlopePerDay(loss, 28)!).toBeLessThan(0);
  });
});
