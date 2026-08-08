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
  /** Below this fraction of logged days, confidence caps at 'low'. */
  minCoverage: number;
  energyDensityPerLb?: number;
}

export const DEFAULT_TDEE_OPTIONS: TdeeOptions = {
  windowDays: 28,
  minCoverage: 0.7,
};

export interface TdeeEstimate {
  /** Point estimate, kcal/day. Never display this alone — use the range. */
  kcal: number;
  low: number;
  high: number;
  confidence: Confidence;
  /** Days in the window with a logged intake entry. */
  loggedDays: number;
  windowDays: number;
  coverage: number;
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
  if (slope === null || window.length === 0) return null;

  const meanIntake = mean(window.map((e) => e.calories));
  const kcal = meanIntake - slope * density;

  const loggedDays = new Set(window.map((e) => e.date)).size;
  const coverage = loggedDays / o.windowDays;

  // Residual: how well the energy-balance model explains the observed trend.
  // Higher day-to-day intake variance with the same trend means the model is
  // fitting noise, so widen the interval.
  const sd = stdev(window.map((e) => e.calories));
  const sem = window.length > 1 ? sd / Math.sqrt(window.length) : sd;
  const halfWidth = Math.max(60, Math.round((1.96 * sem) / 10) * 10);

  const warmingUp = isWarmingUp(inputs.trend);

  const { confidence, reason } = scoreConfidence({
    loggedDays,
    windowDays: o.windowDays,
    coverage,
    minCoverage: o.minCoverage,
    sd,
    warmingUp,
    totalTrendDays: inputs.trend.length,
  });

  return {
    kcal: Math.round(kcal),
    low: Math.round(kcal - halfWidth),
    high: Math.round(kcal + halfWidth),
    confidence,
    loggedDays,
    windowDays: o.windowDays,
    coverage,
    slopePerDay: slope,
    energyDensityPerLb: density,
    warmingUp,
    reason,
  };
}

function scoreConfidence(x: {
  loggedDays: number;
  windowDays: number;
  coverage: number;
  minCoverage: number;
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
  if (x.loggedDays >= 28 && x.sd < 400) {
    return {
      confidence: 'high',
      reason: `${x.loggedDays} logged days at ${Math.round(x.coverage * 100)}% coverage with consistent intake.`,
    };
  }
  return {
    confidence: 'medium',
    reason: `${x.loggedDays} logged days at ${Math.round(x.coverage * 100)}% coverage. 28+ consistent days would raise this to high.`,
  };
}

/**
 * Separate expenditure for shift days and off days.
 *
 * A standing retail shift can run 300-500 kcal above a rest day. Eating a flat
 * number means a surplus on off days and maintenance on shift days. MacroFactor
 * does not model this; it is the most interesting problem in the project.
 *
 * Method: attribute the difference in mean intake between tagged day types to
 * the difference in expenditure, only once both types have enough days that the
 * difference is not noise. Returns null until then.
 */
export interface TaggedExpenditure {
  base: TdeeEstimate;
  shift: number;
  off: number;
  deltaKcal: number;
  shiftDays: number;
  offDays: number;
  reason: string;
}

export function estimateTaggedExpenditure(
  base: TdeeEstimate,
  intake: readonly IntakeEntry[],
  today: IsoDate,
  minDaysPerTag = 7,
): TaggedExpenditure | null {
  const window = intake.filter((e) => {
    const age = daysBetween(e.date, today);
    return age >= 0 && age < base.windowDays;
  });

  const byTag = (tag: ActivityTag) => window.filter((e) => e.activityTag === tag);
  const shiftEntries = byTag('shift');
  const offEntries = byTag('off');

  if (shiftEntries.length < minDaysPerTag || offEntries.length < minDaysPerTag) return null;

  const shiftShare = shiftEntries.length / window.length;
  const offShare = offEntries.length / window.length;

  // Intake difference alone is a weak signal (you may just eat more on shifts),
  // so this is bounded to a plausible NEAT range rather than trusted outright.
  const rawDelta = mean(shiftEntries.map((e) => e.calories)) - mean(offEntries.map((e) => e.calories));
  const delta = clamp(rawDelta, 0, 600);

  const shift = Math.round(base.kcal + delta * offShare);
  const off = Math.round(base.kcal - delta * shiftShare);

  return {
    base,
    shift,
    off,
    deltaKcal: Math.round(delta),
    shiftDays: shiftEntries.length,
    offDays: offEntries.length,
    reason:
      delta === 0
        ? 'No measurable difference between shift and off days yet. Eating the same number on both is fine.'
        : `Shift days run about ${Math.round(delta)} kcal above off days across ${shiftEntries.length} shift and ${offEntries.length} off days. Estimate is bounded to a plausible NEAT range, not taken at face value.`,
  };
}

function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
