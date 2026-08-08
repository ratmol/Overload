/**
 * TDEE estimation from intake and weight trend, with an explicit confidence
 * model and separate shift-day / off-day expenditure.
 *
 * The core identity:
 *   TDEE ≈ meanIntake - (trendSlopePerDay × energyDensityPerLb)
 *
 * The single most important parameter is energyDensityPerLb, and it is NOT
 * 3500. 3500 kcal/lb is the energy density of body fat. Tissue gained in a lean
 * gain is a mix, and lean tissue is mostly water at roughly 700-800 kcal/lb.
 * See docs/ALGORITHM.md for the derivation. A naive 3500 overfeeds by roughly
 * 200 kcal/day during a gain phase.
 */
import { daysBetween, mean } from './dates.js';
import { isWarmingUp, trendSlopePerDay, trendWarmupDays, type TrendPoint } from './trend.js';
import type { ActivityTag, Confidence, GoalType, IntakeEntry, IsoDate } from './types.js';

/** Effective kcal per lb of bodyweight change, by phase. */
export const ENERGY_DENSITY_PER_LB: Record<GoalType, number> = {
  /** 60/40 lean:fat accrual → 0.6×750 + 0.4×3500 = 1850. Rounded up to 2500
   *  as a deliberately conservative default: overestimating density makes the
   *  engine under-correct, which is the safer failure direction on a gain. */
  gain: 2500,
  /** Loss is fat-dominant but not purely fat; 3200 not 3500. */
  loss: 3200,
  /** Maintenance has no meaningful direction; use the gain figure. */
  maintain: 2500,
};

export interface TdeeOptions {
  windowDays: number;
  /** Below this fraction of logged intake days, confidence caps at 'low'. */
  minCoverage: number;
  /**
   * Below this fraction of days with an actual weigh-in, confidence caps at
   * 'low'. Distinct from intake coverage and easy to miss: computeTrend()
   * carries the trend forward across gaps, so the trend series is always dense
   * even when there is almost no weight data behind it. Regressing over a
   * staircase of carried-forward values produces a confident, badly attenuated
   * slope. Weekly weigh-ins alone read ~38% low.
   */
  minWeighInCoverage: number;
  /**
   * The trend window must reach within this many days of `today`, or the two
   * halves of the energy-balance identity are measured over different day sets.
   */
  maxWeighInStalenessDays: number;
  energyDensityPerLb?: number;
}

export const DEFAULT_TDEE_OPTIONS: TdeeOptions = {
  windowDays: 28,
  minCoverage: 0.7,
  minWeighInCoverage: 0.5,
  maxWeighInStalenessDays: 3,
};

export interface TdeeEstimate {
  /** Point estimate, kcal/day. Never display this alone — use the range. */
  kcal: number;
  low: number;
  high: number;
  confidence: Confidence;
  /** Distinct DATES in the window with at least one intake entry. */
  loggedDays: number;
  /** Distinct dates in the window with an actual weigh-in (not carried forward). */
  weighInDays: number;
  windowDays: number;
  coverage: number;
  weighInCoverage: number;
  /** Days between the last real weigh-in and `today`. */
  weighInStalenessDays: number;
  /** lb/day. Negative = losing. */
  slopePerDay: number;
  energyDensityPerLb: number;
  /**
   * True while the EWMA has not settled. The slope — and therefore the whole
   * estimate — is biased toward zero during this period.
   */
  warmingUp: boolean;
  /** Why the confidence landed where it did. Show this in the UI. */
  reason: string;
}

export interface TdeeInputs {
  today: IsoDate;
  trend: readonly TrendPoint[];
  intake: readonly IntakeEntry[];
  goalType: GoalType;
}

export function estimateTdee(
  inputs: TdeeInputs,
  options: Partial<TdeeOptions> = {},
): TdeeEstimate | null {
  const o = { ...DEFAULT_TDEE_OPTIONS, ...options };
  const density = o.energyDensityPerLb ?? ENERGY_DENSITY_PER_LB[inputs.goalType];

  const window = inputs.intake.filter((e) => {
    const age = daysBetween(e.date, inputs.today);
    return age >= 0 && age < o.windowDays;
  });

  const trendWindow = inputs.trend.filter((p) => {
    const age = daysBetween(p.date, inputs.today);
    return age >= 0 && age < o.windowDays;
  });

  const slope = trendSlopePerDay(trendWindow, o.windowDays);
  if (slope === null || !Number.isFinite(slope) || window.length === 0) return null;

  // Aggregate to DAILY TOTALS before averaging. `mean` over raw entries is a
  // per-entry mean, so a user logging four meal rows a day would have their
  // intake divided by four. Nothing in IntakeEntry forbids multiple rows/day.
  const dailyTotals = new Map<IsoDate, number>();
  for (const e of window) {
    dailyTotals.set(e.date, (dailyTotals.get(e.date) ?? 0) + e.calories);
  }
  const dailyKcal = [...dailyTotals.values()];

  const meanIntake = mean(dailyKcal);
  if (!Number.isFinite(meanIntake)) return null;

  const kcal = meanIntake - slope * density;
  if (!Number.isFinite(kcal)) return null;

  const loggedDays = dailyTotals.size;
  const coverage = loggedDays / o.windowDays;

  const realWeighIns = trendWindow.filter((p) => p.raw !== null);
  const weighInDays = realWeighIns.length;
  const weighInCoverage = weighInDays / o.windowDays;
  const lastWeighIn = realWeighIns[realWeighIns.length - 1];
  const weighInStalenessDays = lastWeighIn
    ? daysBetween(lastWeighIn.date, inputs.today)
    : Number.POSITIVE_INFINITY;

  // Interval on the intake term only. It does NOT propagate slope uncertainty,
  // and the slope is regressed over an EWMA-smoothed (heavily autocorrelated)
  // series, so a naive OLS standard error would understate badly anyway. The
  // 150 kcal floor is a deliberate honesty measure: the real uncertainty on
  // this quantity is closer to +/-300 than the +/-60 the arithmetic suggests.
  const sd = stdev(dailyKcal);
  const sem = dailyKcal.length > 1 ? sd / Math.sqrt(dailyKcal.length) : sd;
  const halfWidth = Math.max(150, Math.round((1.96 * sem) / 25) * 25);

  const warmingUp = isWarmingUp(inputs.trend);

  const { confidence, reason } = scoreConfidence({
    loggedDays,
    windowDays: o.windowDays,
    coverage,
    minCoverage: o.minCoverage,
    weighInCoverage,
    minWeighInCoverage: o.minWeighInCoverage,
    weighInStalenessDays,
    maxWeighInStalenessDays: o.maxWeighInStalenessDays,
    sd,
    warmingUp,
    totalTrendDays: inputs.trend.length,
  });

  return {
    kcal: round25(kcal),
    low: round25(kcal - halfWidth),
    high: round25(kcal + halfWidth),
    confidence,
    loggedDays,
    weighInDays,
    windowDays: o.windowDays,
    coverage,
    weighInCoverage,
    weighInStalenessDays,
    slopePerDay: slope,
    energyDensityPerLb: density,
    warmingUp,
    reason,
  };
}

/** Reporting a TDEE to the single calorie implies precision that isn't there. */
function round25(n: number): number {
  return Math.round(n / 25) * 25;
}

function scoreConfidence(x: {
  loggedDays: number;
  windowDays: number;
  coverage: number;
  minCoverage: number;
  weighInCoverage: number;
  minWeighInCoverage: number;
  weighInStalenessDays: number;
  maxWeighInStalenessDays: number;
  sd: number;
  warmingUp: boolean;
  totalTrendDays: number;
}): { confidence: Confidence; reason: string } {
  if (x.warmingUp) {
    return {
      confidence: 'low',
      reason: `Only ${x.totalTrendDays} days of weight history. The trend filter needs about ${trendWarmupDays()} days to settle, and until then it reads the rate of change as slower than it is.`,
    };
  }
  if (x.weighInStalenessDays > x.maxWeighInStalenessDays) {
    return {
      confidence: 'low',
      reason: Number.isFinite(x.weighInStalenessDays)
        ? `Last weigh-in was ${x.weighInStalenessDays} days ago. The weight and intake halves of the calculation would be measured over different stretches of time.`
        : 'No weigh-ins in the window at all.',
    };
  }
  if (x.weighInCoverage < x.minWeighInCoverage) {
    return {
      confidence: 'low',
      reason: `Weighed in on ${Math.round(x.weighInCoverage * 100)}% of days. Below ${Math.round(x.minWeighInCoverage * 100)}% the trend is mostly carried-forward values, which flattens the estimated rate.`,
    };
  }
  if (x.loggedDays < 14) {
    return {
      confidence: 'low',
      reason: `Only ${x.loggedDays} logged days. Under 14 days the estimate is always low confidence.`,
    };
  }
  if (x.coverage < x.minCoverage) {
    return {
      confidence: 'low',
      reason: `Coverage ${Math.round(x.coverage * 100)}% of the ${x.windowDays}-day window. Below ${Math.round(x.minCoverage * 100)}% caps confidence at low.`,
    };
  }
  // Gate on coverage, not on an absolute day count that happens to equal the
  // default window size. At windowDays 28 the old `loggedDays >= 28` meant
  // 100% logging, so a single missed day capped confidence at medium forever.
  if (x.coverage >= 0.9 && x.windowDays >= 28 && x.weighInCoverage >= 0.8 && x.sd < 400) {
    return {
      confidence: 'high',
      reason: `${x.loggedDays} logged days at ${Math.round(x.coverage * 100)}% coverage with consistent intake and near-daily weigh-ins.`,
    };
  }
  return {
    confidence: 'medium',
    reason: `${x.loggedDays} logged days at ${Math.round(x.coverage * 100)}% coverage. Near-daily logging and weigh-ins over a 28-day window would raise this to high.`,
  };
}

/**
 * How much MORE the user eats on shift days than off days.
 *
 * This is a description of intake, not an inference about expenditure, and the
 * naming is deliberate. An earlier version of this function reported
 * `shift`/`off` expenditure figures derived from the intake difference. That
 * was circular: the number came out algebraically identical to its own input,
 * never touched the weight trend, and therefore contained exactly zero
 * evidence about energy expenditure. Worse, once the app started issuing split
 * targets, the next window's intake difference would equal the prescribed
 * difference, which the engine would then re-attribute to expenditure — a
 * self-confirming loop with no external anchor.
 *
 * It also clamped the result to [0, 600], which censored the disconfirming
 * direction. A user who is busier and eats LESS on shift days — the common
 * retail case, and the one where a split target actually matters — was told
 * "no measurable difference, eating the same on both is fine."
 *
 * The honest version of the expenditure question needs step count as a direct
 * input, or a regression of daily trend change on intake with a tag dummy over
 * far more than 7 days per tag. Until then, report what was actually measured.
 */
export interface TaggedIntakeSummary {
  meanShiftKcal: number;
  meanOffKcal: number;
  /** Signed. Negative means eating less on shift days. */
  deltaKcal: number;
  /**
   * Half-width of a ~95% interval on the difference. With realistic day-to-day
   * intake variation (sd ~200 kcal) and a few weeks per tag, this lands around
   * +/-120 kcal — so a fixed "is it more than 50 kcal?" cutoff would call pure
   * sampling noise a real pattern most of the time.
   */
  marginKcal: number;
  /** True only when the difference clears its own noise floor. */
  isSignificant: boolean;
  shiftDays: number;
  offDays: number;
  reason: string;
}

export function summariseTaggedIntake(
  intake: readonly IntakeEntry[],
  today: IsoDate,
  windowDays = DEFAULT_TDEE_OPTIONS.windowDays,
  minDaysPerTag = 7,
): TaggedIntakeSummary | null {
  const window = intake.filter((e) => {
    const age = daysBetween(e.date, today);
    return age >= 0 && age < windowDays;
  });

  const dailyByTag = (tag: ActivityTag): number[] => {
    const totals = new Map<IsoDate, number>();
    for (const e of window) {
      if (e.activityTag !== tag) continue;
      totals.set(e.date, (totals.get(e.date) ?? 0) + e.calories);
    }
    return [...totals.values()];
  };

  const shift = dailyByTag('shift');
  const off = dailyByTag('off');
  if (shift.length < minDaysPerTag || off.length < minDaysPerTag) return null;

  const meanShift = mean(shift);
  const meanOff = mean(off);
  const delta = meanShift - meanOff;

  // Welch standard error of the difference of two means.
  const se = Math.sqrt(
    stdev(shift) ** 2 / shift.length + stdev(off) ** 2 / off.length,
  );
  const margin = 1.96 * se;
  const isSignificant = Math.abs(delta) > margin;

  return {
    meanShiftKcal: Math.round(meanShift),
    meanOffKcal: Math.round(meanOff),
    deltaKcal: Math.round(delta),
    marginKcal: Math.round(margin),
    isSignificant,
    shiftDays: shift.length,
    offDays: off.length,
    reason: describeTaggedIntake({
      delta: Math.round(delta),
      margin: Math.round(margin),
      isSignificant,
      shiftDays: shift.length,
      offDays: off.length,
    }),
  };
}

function describeTaggedIntake(x: {
  delta: number;
  margin: number;
  isSignificant: boolean;
  shiftDays: number;
  offDays: number;
}): string {
  const span = `across ${x.shiftDays} shift and ${x.offDays} off days`;

  if (!x.isSignificant) {
    return `No difference you can distinguish from ordinary day-to-day variation ${span} — the gap is ${x.delta >= 0 ? '+' : ''}${x.delta} kcal against a margin of +/-${x.margin}. Note that eating the same on both is not obviously right: a standing shift plausibly costs 300-500 kcal more than a rest day, so one flat number likely means a surplus on off days and closer to maintenance on shift days. Confirming that needs step data, which this app does not collect yet.`;
  }
  if (x.delta < 0) {
    return `You eat about ${Math.abs(x.delta)} kcal LESS on shift days (+/-${x.margin}) ${span} — probably the days you expend the most. This is the pattern most likely to stall a lean gain.`;
  }
  return `You eat about ${x.delta} kcal more on shift days (+/-${x.margin}) ${span}. This describes your intake, not your expenditure — the two only match if the extra food happened to match extra activity.`;
}

function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}
