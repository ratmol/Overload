/**
 * Weight trend: EWMA with MAD-based outlier downweighting.
 *
 * Design commitments (see docs/ALGORITHM.md):
 *  - Missing days carry the trend forward. We never interpolate a fake reading,
 *    because a fake reading would later be indistinguishable from a real one
 *    in the TDEE window coverage calculation.
 *  - Outliers are DOWNWEIGHTED (alpha halved), never deleted. Deleting user
 *    data silently is the one thing this project will not do.
 *  - trend[0] seeds from the mean of the first up-to-3 readings. Seeding from
 *    a single reading makes the first two weeks of trend a function of one
 *    possibly-bad scale number.
 *  - The outlier test measures each reading against the CURRENT TREND, not
 *    against the median of a trailing window. A trailing median inside a
 *    genuine weight trend is offset from the present by half the window, which
 *    made ordinary readings look extreme and produced ~12% false flags on
 *    realistic noise. Residuals against the trend are trend-free by
 *    construction, so the MAD estimates scale rather than scale-plus-drift.
 */
import { addDays, daysBetween, median } from './dates.js';
import type { IsoDate, WeightEntry } from './types.js';

export interface TrendOptions {
  /** Days for the EWMA to decay to half weight. */
  halfLifeDays: number;
  /** Trailing window of residuals used to estimate scale. */
  outlierWindowDays: number;
  /** Deviations beyond this many MADs get their alpha halved. */
  outlierMadThreshold: number;
  /**
   * Minimum residuals before the outlier test runs at all. MAD is biased low
   * on small samples, so testing early manufactures outliers.
   */
  minResidualsForOutlierTest: number;
  /**
   * Floor on the estimated scale, in lb. Below this the MAD is measuring
   * rounding, not noise, and every real reading looks like an outlier. A
   * digital scale plus normal hydration swing is never tighter than ~0.4 lb.
   */
  minScaleLb: number;
}

/**
 * Threshold is 4 MAD, not 3.
 *
 * The job of this test is to catch readings that are implausible as physiology
 * plus scale noise — a clothed weigh-in, a different scale, a post-meal weigh —
 * not merely uncommon ones. Those are 3+ lb off, which is 4+ sigma at a typical
 * 0.7 lb daily noise level. At 3 MAD the test fired on ~5% of ordinary
 * readings, because a MAD estimated from a two-week window is itself noisy and
 * periodically comes out too small. Every false flag halves the weight of a
 * real data point, so the cost of being trigger-happy is a trend that ignores
 * legitimate movement.
 */
export const DEFAULT_TREND_OPTIONS: TrendOptions = {
  halfLifeDays: 7,
  outlierWindowDays: 21,
  outlierMadThreshold: 4,
  minResidualsForOutlierTest: 10,
  minScaleLb: 0.4,
};

export interface TrendPoint {
  date: IsoDate;
  /** The raw reading, or null on a day with no weigh-in. */
  raw: number | null;
  /** Smoothed value. Always present once seeded. */
  trend: number;
  /** True when the reading was beyond the MAD threshold. Surface this in UI. */
  flaggedOutlier: boolean;
}

export function alphaFromHalfLife(halfLifeDays: number): number {
  if (halfLifeDays <= 0) throw new RangeError('halfLifeDays must be > 0');
  return 1 - Math.pow(0.5, 1 / halfLifeDays);
}

/**
 * Median absolute deviation. Scaled by 1.4826 so that for normally distributed
 * data one MAD ≈ one standard deviation, which makes the "3 MAD" threshold
 * mean roughly what a reader expects it to mean.
 */
export function mad(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

/**
 * Build a day-by-day trend series spanning the first to the last entry.
 * Entries are de-duplicated by date (last write wins) and sorted internally,
 * so callers may pass an unsorted log.
 */
export function computeTrend(
  entries: readonly WeightEntry[],
  options: Partial<TrendOptions> = {},
): TrendPoint[] {
  const opts = { ...DEFAULT_TREND_OPTIONS, ...options };
  if (entries.length === 0) return [];

  const byDate = new Map<IsoDate, number>();
  for (const e of [...entries].sort((a, b) => a.date.localeCompare(b.date))) {
    byDate.set(e.date, e.weightLb);
  }
  const dates = [...byDate.keys()].sort();
  const first = dates[0]!;
  const last = dates[dates.length - 1]!;

  const seedValues = dates.slice(0, 3).map((d) => byDate.get(d)!);
  const seed = seedValues.reduce((a, b) => a + b, 0) / seedValues.length;

  const baseAlpha = alphaFromHalfLife(opts.halfLifeDays);
  const out: TrendPoint[] = [];
  /** raw - trend, i.e. the part of a reading the model did not expect. */
  const residuals: { date: IsoDate; value: number }[] = [];
  let current = seed;

  for (let i = 0; i <= daysBetween(first, last); i++) {
    const date = addDays(first, i);
    const raw = byDate.get(date) ?? null;

    if (raw === null) {
      // No reading: carry forward. Do not invent data.
      out.push({ date, raw: null, trend: current, flaggedOutlier: false });
      continue;
    }

    while (
      residuals.length > 0 &&
      daysBetween(residuals[0]!.date, date) > opts.outlierWindowDays
    ) {
      residuals.shift();
    }

    const residual = raw - current;
    let flagged = false;
    if (residuals.length >= opts.minResidualsForOutlierTest) {
      const values = residuals.map((r) => r.value);
      const scale = Math.max(mad(values), opts.minScaleLb);
      if (Math.abs(residual - median(values)) > opts.outlierMadThreshold * scale) {
        flagged = true;
      }
    }

    const alpha = flagged ? baseAlpha / 2 : baseAlpha;
    current = alpha * raw + (1 - alpha) * current;
    // A flagged reading still informs the scale estimate. Excluding it would
    // let the window tighten around a quiet stretch and flag everything after.
    residuals.push({ date, value: residual });
    out.push({ date, raw, trend: current, flaggedOutlier: flagged });
  }

  return out;
}

/**
 * Days of history before an EWMA slope can be trusted.
 *
 * The EWMA is seeded from a 3-day mean, so early slopes are biased toward zero
 * while the filter catches up. Empirically the bias is ~40% at 6 weeks of
 * history and under 5% by 9 weeks. Four half-lives is the conventional
 * settling point and matches what the synthetic fixtures show.
 *
 * Consequence, and the reason this is exported: during the first two months the
 * engine will UNDERSTATE the rate of gain, which biases toward adding calories
 * that are not needed. estimateTdee() caps confidence while warming up.
 */
export function trendWarmupDays(halfLifeDays = DEFAULT_TREND_OPTIONS.halfLifeDays): number {
  return halfLifeDays * 4;
}

/** True when the series is too short for its slope to be trustworthy. */
export function isWarmingUp(
  series: readonly TrendPoint[],
  halfLifeDays = DEFAULT_TREND_OPTIONS.halfLifeDays,
): boolean {
  return series.length < trendWarmupDays(halfLifeDays);
}

/**
 * Least-squares slope of the trend line in lb/day over the last `windowDays`.
 *
 * Regression rather than (last - first) / days because the endpoint version is
 * hostage to whatever happened on the two boundary days. Returns null when the
 * window is too short to mean anything.
 */
export function trendSlopePerDay(series: readonly TrendPoint[], windowDays: number): number | null {
  const w = series.slice(-windowDays);
  if (w.length < 7) return null;

  const n = w.length;
  const meanX = (n - 1) / 2;
  const meanY = w.reduce((a, p) => a + p.trend, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (w[i]!.trend - meanY);
    den += (i - meanX) ** 2;
  }
  return den === 0 ? null : num / den;
}
