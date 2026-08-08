/**
 * Calorie target adjustment, with guardrails.
 *
 * Every guardrail here is a hard block, not a heuristic. The engine refusing to
 * act is the correct behaviour far more often than it acting on thin data. If a
 * human-readable reason cannot be generated, the change does not happen — that
 * rule is the whole product philosophy in one line.
 *
 * This is a controller with a long, known lag: a 7-day EWMA half-life feeding a
 * 28-day regression means a change made today is not fully visible for 2-3
 * weeks. Adjusting weekly into that lag is textbook integral windup — the
 * controller stacks corrections for a change it cannot see yet. Three things
 * prevent it: a rate DEADBAND (do nothing inside the target band), a 14-day
 * minimum between adjustments, and a damping factor on the computed delta.
 */
import { daysBetween } from './dates.js';
import type { Confidence, GoalType, IsoDate, UserProfile } from './types.js';
import type { TdeeEstimate } from './tdee.js';

export interface AdjustOptions {
  maxChangeKcal: number;
  minDaysBetweenAdjustments: number;
  minLoggedDays: number;
  minCoverage: number;
  /** Fraction of the computed correction actually applied. See file header. */
  damping: number;
  /** No adjustment during, or within this many days after, a deload. */
  deloadCooldownDays: number;
  /** Absolute floor. Nothing may push the target below this. */
  minTargetKcal: number;
  /** Cumulative drift from baseline past which auto-adjustment stops. */
  maxCumulativeDriftKcal: number;
}

export const DEFAULT_ADJUST_OPTIONS: AdjustOptions = {
  maxChangeKcal: 100,
  /**
   * 14, not 7. Two EWMA half-lives, so the previous change has actually
   * propagated into the trend before the next one is computed.
   */
  minDaysBetweenAdjustments: 14,
  minLoggedDays: 14,
  minCoverage: 0.7,
  damping: 0.6,
  deloadCooldownDays: 3,
  /**
   * A hard floor of 1600 kcal.
   *
   * Nothing else in the system bounds a downward ratchet, and the ratchet is
   * reachable in weeks: starting creatine and raising carbs adds 2-4 lb of
   * water and glycogen over the first fortnight, which reads as ~1 lb/week of
   * "gain" and invites repeated cuts for a change that was never tissue.
   *
   * 1600 is roughly 1.15x an estimated RMR of ~1394 for this user. Below it,
   * the plan's own non-negotiable minimums (130 g protein = 520 kcal, 60 g fat
   * floor = 540 kcal) consume two thirds of intake and leave no training fuel,
   * which makes the plan internally incoherent. Override per-user via
   * UserProfile.minTargetKcal, ideally recomputed from fat-free mass.
   */
  minTargetKcal: 1600,
  maxCumulativeDriftKcal: 300,
};

export type BlockReason =
  | 'warming-up'
  | 'low-confidence'
  | 'insufficient-logged-days'
  | 'insufficient-coverage'
  | 'too-soon'
  | 'deload-cooldown'
  | 'calories-locked'
  | 'in-target-band'
  | 'floor-reached'
  | 'needs-review';

export interface AdjustDecision {
  changed: boolean;
  previousTarget: number;
  newTarget: number;
  deltaKcal: number;
  confidence: Confidence;
  blockedBy?: BlockReason;
  /**
   * True when the engine wants a human to look. Distinct from a plain block:
   * it means the data is good and the model still cannot explain it.
   */
  needsReview?: boolean;
  /** Always populated. Never empty. */
  reason: string;
}

export interface AdjustInputs {
  today: IsoDate;
  profile: Pick<
    UserProfile,
    'goalType' | 'targetRateBandLbPerWeek' | 'caloriesLocked' | 'minTargetKcal'
  >;
  currentTarget: number;
  /** The user's original target, for cumulative drift detection. */
  baselineTarget?: number;
  estimate: TdeeEstimate;
  /** Date of the most recent adjustment, if any. */
  lastAdjustmentDate?: IsoDate;
  /** Last day of the most recent deload week, if any. */
  lastDeloadEndDate?: IsoDate;
  /** True if the current week is a deload. */
  inDeloadWeek: boolean;
  /**
   * Consecutive prior adjustments that pushed in the same direction without the
   * trend responding. Drives the needs-review escalation.
   */
  consecutiveUnresponsiveAdjustments?: number;
}

export function adjustTarget(
  inputs: AdjustInputs,
  options: Partial<AdjustOptions> = {},
): AdjustDecision {
  const o = { ...DEFAULT_ADJUST_OPTIONS, ...options };
  const { estimate, profile, currentTarget } = inputs;
  const floor = profile.minTargetKcal ?? o.minTargetKcal;

  const block = (blockedBy: BlockReason, reason: string): AdjustDecision => ({
    changed: false,
    previousTarget: currentTarget,
    newTarget: currentTarget,
    deltaKcal: 0,
    confidence: estimate.confidence,
    blockedBy,
    reason,
  });

  // --- Non-negotiable blocks, in order of authority ------------------------

  if (profile.caloriesLocked) {
    return block('calories-locked', 'Calories are locked. No automatic change.');
  }
  if (!Number.isFinite(estimate.slopePerDay) || !Number.isFinite(estimate.energyDensityPerLb)) {
    return block(
      'low-confidence',
      'The trend estimate is not a usable number. This is a data problem, not a nutrition one — check the weight log for a bad entry.',
    );
  }
  if (inputs.inDeloadWeek) {
    return block(
      'deload-cooldown',
      'Deload week. Calories stay exactly where they are — recovery is calorie-expensive and a deload-week weight swing is not a signal.',
    );
  }
  if (inputs.lastDeloadEndDate !== undefined) {
    const since = daysBetween(inputs.lastDeloadEndDate, inputs.today);
    if (since < o.deloadCooldownDays) {
      return block(
        'deload-cooldown',
        `Only ${since} day(s) since the deload ended. Waiting ${o.deloadCooldownDays} days for water weight to settle before reading the trend.`,
      );
    }
  }

  // --- Data-sufficiency blocks --------------------------------------------
  //
  // These mirror what estimateTdee already refuses to trust. Previously the
  // adjustment engine would act on data the estimator itself had labelled
  // low-confidence, which was incoherent.

  if (estimate.warmingUp) {
    return block(
      'warming-up',
      'The weight trend has not settled yet. Until it does it reads the rate of change as slower than it really is, and acting on that would add calories you do not need. Keep logging.',
    );
  }
  if (estimate.confidence === 'low') {
    return block('low-confidence', `Not confident enough to change anything. ${estimate.reason}`);
  }
  if (estimate.loggedDays < o.minLoggedDays) {
    return block(
      'insufficient-logged-days',
      `Only ${estimate.loggedDays} logged days in the window. Need ${o.minLoggedDays} before changing anything.`,
    );
  }
  if (estimate.coverage < o.minCoverage) {
    return block(
      'insufficient-coverage',
      `Logged ${Math.round(estimate.coverage * 100)}% of days. Below ${Math.round(o.minCoverage * 100)}% the gaps are usually the biggest days, which biases the whole estimate.`,
    );
  }
  if (inputs.lastAdjustmentDate !== undefined) {
    const since = daysBetween(inputs.lastAdjustmentDate, inputs.today);
    // No `since >= 0` guard: a future-dated value is MORE suspicious, not less,
    // and previously skipped the cooldown entirely.
    if (since < o.minDaysBetweenAdjustments) {
      return block(
        'too-soon',
        `Last adjustment was ${since} day(s) ago. One change per ${o.minDaysBetweenAdjustments} days, because a change takes two weeks to show up in the trend and adjusting faster stacks corrections for something not yet visible.`,
      );
    }
  }

  // --- The deadband, in rate space ----------------------------------------
  //
  // The plan specifies a BAND (0.25-0.5 lb/week), not a point. Comparing to a
  // scalar and treating a 25 kcal rounding step as the deadband made the real
  // tolerance 0.035 lb/week — far below what a smoothed scale trend can
  // resolve — so the engine adjusted almost every cycle, usually at the cap.

  const observedRate = estimate.slopePerDay * 7;
  const [bandLo, bandHi] = profile.targetRateBandLbPerWeek;

  if (observedRate >= bandLo && observedRate <= bandHi) {
    return block(
      'in-target-band',
      `${fmtRate(observedRate)} is inside your target band of ${fmtRate(bandLo)} to ${fmtRate(bandHi)}. Nothing to change.`,
    );
  }

  // Correct to the nearest EDGE of the band, not to its midpoint. Aiming at the
  // middle guarantees an overshoot half the time.
  const nearestEdge = observedRate < bandLo ? bandLo : bandHi;
  const rateError = nearestEdge - observedRate;

  const rawDelta = (rateError * estimate.energyDensityPerLb) / 7;
  const damped = rawDelta * o.damping;
  const delta = clampToStep(damped, o.maxChangeKcal);

  if (delta === 0) {
    return block(
      'in-target-band',
      `${fmtRate(observedRate)} against a band of ${fmtRate(bandLo)} to ${fmtRate(bandHi)}. The correction rounds to nothing.`,
    );
  }

  // --- Escalation: good data, model still cannot explain it ----------------

  const unresponsive = inputs.consecutiveUnresponsiveAdjustments ?? 0;
  const drift =
    inputs.baselineTarget === undefined ? 0 : currentTarget + delta - inputs.baselineTarget;

  if (unresponsive >= 3 && Math.abs(drift) >= o.maxCumulativeDriftKcal) {
    return {
      ...block(
        'needs-review',
        `Your intake has moved ${drift > 0 ? 'up' : 'down'} ${Math.abs(Math.round(drift))} kcal across several cycles and the weight trend still has not responded. At this point the most likely explanations are no longer calories. Your plan lists a baseline blood panel — iron and ferritin, B12, vitamin D, TSH, and a celiac screen — as the highest-priority thing to rule out. Worth raising with a doctor before adding more food.`,
      ),
      needsReview: true,
    };
  }

  // --- Floor and ceiling ---------------------------------------------------

  const uncapped = currentTarget + delta;

  if (uncapped < floor) {
    return block(
      'floor-reached',
      `That change would put you at ${Math.round(uncapped)} kcal, below the ${floor} kcal floor. On a lean gain the engine should never be walking your calories down to your resting metabolic rate — if it wants to, the model is wrong, not your appetite.`,
    );
  }

  // On a gain or maintain goal, the engine has no business proposing a target
  // below the bottom of its own estimated expenditure range.
  if (profile.goalType !== 'loss' && uncapped < estimate.low) {
    return block(
      'floor-reached',
      `That change would put your target below the low end of your own estimated expenditure (${estimate.low} kcal) while your goal is to ${profile.goalType}. That is a contradiction in the model, not an instruction to eat less.`,
    );
  }

  const newTarget = uncapped;
  const capped = Math.abs(damped) > o.maxChangeKcal;

  return {
    changed: true,
    previousTarget: currentTarget,
    newTarget,
    deltaKcal: delta,
    confidence: estimate.confidence,
    reason: buildReason({
      observedRate,
      bandLo,
      bandHi,
      delta,
      newTarget,
      capped,
      maxChange: o.maxChangeKcal,
      damping: o.damping,
      estimate,
      goalType: profile.goalType,
    }),
  };
}

/**
 * Round to the nearest 25 kcal and cap. Anything under 25 is treated as zero
 * rather than rounded up to 25 — plain `Math.round(x/25)*25` would amplify a
 * 13 kcal correction into a 25 kcal change, which is the opposite of a
 * deadband.
 */
function clampToStep(raw: number, max: number): number {
  if (Math.abs(raw) < 25) return 0;
  const capped = Math.max(-max, Math.min(max, raw));
  return Math.round(capped / 25) * 25;
}

function buildReason(x: {
  observedRate: number;
  bandLo: number;
  bandHi: number;
  delta: number;
  newTarget: number;
  capped: boolean;
  maxChange: number;
  damping: number;
  estimate: TdeeEstimate;
  goalType: GoalType;
}): string {
  const dir = x.delta > 0 ? 'up' : 'down';
  const parts = [
    `Trend shows ${fmtRate(x.observedRate)}, outside your target band of ${fmtRate(x.bandLo)} to ${fmtRate(x.bandHi)}.`,
    `Moving calories ${dir} ${Math.abs(x.delta)} to ${x.newTarget}.`,
    `Estimated expenditure ${x.estimate.kcal} kcal (${x.estimate.low}-${x.estimate.high}), ${x.estimate.confidence} confidence.`,
    `Using ${x.estimate.energyDensityPerLb} kcal/lb for a ${x.goalType} phase, not 3500.`,
    `Applying ${Math.round(x.damping * 100)}% of the computed correction, because a change takes about two weeks to show up.`,
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
