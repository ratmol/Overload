/**
 * Calorie target adjustment, with guardrails.
 *
 * Every guardrail here is a hard block, not a heuristic. The engine refusing to
 * act is the correct behaviour far more often than it acting on thin data. If a
 * human-readable reason cannot be generated, the change does not happen — that
 * rule is the whole product philosophy in one line.
 */
import { daysBetween } from './dates.js';
import type { Confidence, GoalType, IsoDate, UserProfile } from './types.js';
import type { TdeeEstimate } from './tdee.js';

export interface AdjustOptions {
  maxChangeKcal: number;
  minDaysBetweenAdjustments: number;
  minLoggedDays: number;
  minWindowDays: number;
  /** No adjustment during, or within this many days after, a deload. */
  deloadCooldownDays: number;
}

export const DEFAULT_ADJUST_OPTIONS: AdjustOptions = {
  maxChangeKcal: 100,
  minDaysBetweenAdjustments: 7,
  minLoggedDays: 10,
  minWindowDays: 14,
  deloadCooldownDays: 3,
};

export type BlockReason =
  | 'insufficient-window'
  | 'insufficient-logged-days'
  | 'too-soon'
  | 'deload-cooldown'
  | 'calories-locked'
  | 'on-target';

export interface AdjustDecision {
  changed: boolean;
  previousTarget: number;
  newTarget: number;
  deltaKcal: number;
  confidence: Confidence;
  blockedBy?: BlockReason;
  /** Always populated. Never empty. */
  reason: string;
}

export interface AdjustInputs {
  today: IsoDate;
  profile: Pick<UserProfile, 'goalType' | 'targetRatePerWeekLb' | 'caloriesLocked'>;
  currentTarget: number;
  estimate: TdeeEstimate;
  /** Date of the most recent adjustment, if any. */
  lastAdjustmentDate?: IsoDate;
  /** Last day of the most recent deload week, if any. */
  lastDeloadEndDate?: IsoDate;
  /** True if the current week is a deload. */
  inDeloadWeek: boolean;
}

export function adjustTarget(
  inputs: AdjustInputs,
  options: Partial<AdjustOptions> = {},
): AdjustDecision {
  const o = { ...DEFAULT_ADJUST_OPTIONS, ...options };
  const { estimate, profile, currentTarget } = inputs;

  const block = (blockedBy: BlockReason, reason: string): AdjustDecision => ({
    changed: false,
    previousTarget: currentTarget,
    newTarget: currentTarget,
    deltaKcal: 0,
    confidence: estimate.confidence,
    blockedBy,
    reason,
  });

  if (profile.caloriesLocked) {
    return block('calories-locked', 'Calories are locked. No automatic change.');
  }
  if (inputs.inDeloadWeek) {
    return block(
      'deload-cooldown',
      'Deload week. Calories stay exactly where they are — recovery is calorie-expensive and a deload-week weight swing is not a signal.',
    );
  }
  if (inputs.lastDeloadEndDate !== undefined) {
    const since = daysBetween(inputs.lastDeloadEndDate, inputs.today);
    if (since >= 0 && since < o.deloadCooldownDays) {
      return block(
        'deload-cooldown',
        `Only ${since} day(s) since the deload ended. Waiting ${o.deloadCooldownDays} days for water weight to settle before reading the trend.`,
      );
    }
  }
  if (estimate.windowDays < o.minWindowDays) {
    return block(
      'insufficient-window',
      `Window is ${estimate.windowDays} days. Need at least ${o.minWindowDays}.`,
    );
  }
  if (estimate.loggedDays < o.minLoggedDays) {
    return block(
      'insufficient-logged-days',
      `Only ${estimate.loggedDays} logged days in the window. Need ${o.minLoggedDays} before changing anything.`,
    );
  }
  if (inputs.lastAdjustmentDate !== undefined) {
    const since = daysBetween(inputs.lastAdjustmentDate, inputs.today);
    if (since >= 0 && since < o.minDaysBetweenAdjustments) {
      return block(
        'too-soon',
        `Last adjustment was ${since} day(s) ago. One change per ${o.minDaysBetweenAdjustments} days, so the previous one has time to show up in the trend.`,
      );
    }
  }

  const observedRate = estimate.slopePerDay * 7;
  const targetRate = profile.targetRatePerWeekLb;
  const rateError = targetRate - observedRate;

  // Convert the weekly rate gap into a daily calorie gap.
  const rawDelta = (rateError * estimate.energyDensityPerLb) / 7;
  const delta = clampToStep(rawDelta, o.maxChangeKcal);

  if (delta === 0) {
    return block(
      'on-target',
      `Gaining ${observedRate.toFixed(2)} lb/week against a ${targetRate.toFixed(2)} target. Close enough — no change.`,
    );
  }

  const newTarget = currentTarget + delta;
  const capped = Math.abs(rawDelta) > o.maxChangeKcal;

  return {
    changed: true,
    previousTarget: currentTarget,
    newTarget,
    deltaKcal: delta,
    confidence: estimate.confidence,
    reason: buildReason({
      observedRate,
      targetRate,
      delta,
      newTarget,
      capped,
      maxChange: o.maxChangeKcal,
      estimate,
      goalType: profile.goalType,
    }),
  };
}

/** Round to the nearest 25 kcal and cap. Sub-25 kcal changes are noise. */
function clampToStep(raw: number, max: number): number {
  const capped = Math.max(-max, Math.min(max, raw));
  return Math.round(capped / 25) * 25;
}

function buildReason(x: {
  observedRate: number;
  targetRate: number;
  delta: number;
  newTarget: number;
  capped: boolean;
  maxChange: number;
  estimate: TdeeEstimate;
  goalType: GoalType;
}): string {
  const dir = x.delta > 0 ? 'up' : 'down';
  const parts = [
    `Trend shows ${fmtRate(x.observedRate)} against a target of ${fmtRate(x.targetRate)}.`,
    `Moving calories ${dir} ${Math.abs(x.delta)} to ${x.newTarget}.`,
    `Estimated expenditure ${x.estimate.kcal} kcal (${x.estimate.low}-${x.estimate.high}), ${x.estimate.confidence} confidence.`,
    `Using ${x.estimate.energyDensityPerLb} kcal/lb for a ${x.goalType} phase, not 3500.`,
  ];
  if (x.capped) {
    parts.push(`Change capped at ${x.maxChange} kcal; the full correction would be larger.`);
  }
  return parts.join(' ');
}

function fmtRate(lbPerWeek: number): string {
  const sign = lbPerWeek >= 0 ? '+' : '';
  return `${sign}${lbPerWeek.toFixed(2)} lb/week`;
}
