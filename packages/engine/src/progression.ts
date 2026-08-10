/**
 * System load and the double-progression state machine.
 *
 * System load is the headline feature. During a lean gain, belt weight
 * understates progress: +45 lb at 132 lb bodyweight and +45 lb at 142 lb are a
 * 10 lb difference in real work. Every other app logs the belt number only.
 */
import { daysBetween } from './dates.js';
import { targetRirForSet } from './types.js';
import type { Exercise, IsoDate, RepRange, WeightEntry } from './types.js';

/**
 * Bodyweight on a given date, from the weight log.
 *
 * Falls back to the most recent PRIOR entry, never a later one. Using a later
 * reading would make historical system loads change retroactively every time a
 * new weight is logged, which makes progress charts lie.
 */
export function bodyweightOn(
  date: IsoDate,
  weights: readonly WeightEntry[],
): number | null {
  let best: WeightEntry | null = null;
  for (const w of weights) {
    if (w.date > date) continue;
    if (best === null || w.date > best.date) best = w;
  }
  return best?.weightLb ?? null;
}

/**
 * Total load moved. For bodyweight-loaded lifts this is bodyweight + belt.
 * Returns null when bodyweight is unknown — the UI must show "—", not a
 * silently-wrong number that looks like a plateau.
 */
export function systemLoad(
  exercise: Pick<Exercise, 'isBodyweightLoaded'>,
  addedWeightLb: number,
  bodyweightLb: number | null,
): number | null {
  if (!exercise.isBodyweightLoaded) return addedWeightLb;
  if (bodyweightLb === null) return null;
  return bodyweightLb + addedWeightLb;
}

export interface Prescription {
  load: number;
  targetReps: RepRange;
  sets: number;
  /**
   * RIR target for each prescribed set, expanded from the exercise's ladder.
   * Always exactly `sets` long, so the UI never has to decide what a missing
   * entry means.
   */
  rirBySet: number[];
  /** Human-readable explanation. Same philosophy as Adjustment.reason. */
  reason: string;
}

/** Expands an exercise's RIR ladder to a concrete per-set list. */
export function rirLadder(exercise: Exercise, sets: number, fallback = 2): number[] {
  return Array.from({ length: sets }, (_, i) => targetRirForSet(exercise, i, fallback));
}

export type ProgressionOutcome = 'advance-load' | 'add-reps' | 'stalled' | 'first-session';

export interface ProgressionResult extends Prescription {
  outcome: ProgressionOutcome;
}

/** Working sets from one session, ordered. Warmups excluded by the caller. */
export interface SessionPerformance {
  date: IsoDate;
  sets: { addedWeightLb: number; reps: number; rir: number }[];
  /**
   * Deload sessions run at ~87.5% with belt weight stripped, so they look
   * identical to a regression. They must be excluded from stall detection or
   * the first session back reads as "no gain", flags a stall, and can trigger
   * a second deload immediately after the first.
   */
  isDeload?: boolean;
}

/** Non-deload sessions only, oldest first. */
function accumulationSessions(history: readonly SessionPerformance[]): SessionPerformance[] {
  return history
    .filter((s) => !s.isDeload && s.sets.length > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Next prescription from the last two sessions of an exercise.
 *
 * Rules:
 *  - Every working set hit the top of the range -> add one increment, reset to
 *    the bottom of the range.
 *  - Otherwise -> same load, chase reps.
 *  - Two consecutive sessions with no gain in either reps or load -> stalled.
 *
 * "Gain" is measured on total reps at equal-or-higher load. A session where
 * load went up and reps went down is progress, not a stall.
 */
export function nextPrescription(
  exercise: Exercise,
  history: readonly SessionPerformance[],
): ProgressionResult {
  const sessions = accumulationSessions(history);
  const last = sessions[sessions.length - 1];
  const prev = sessions[sessions.length - 2];
  const older = sessions[sessions.length - 3];
  const [min, max] = exercise.defaultRepRange;

  if (!last) {
    return {
      load: exercise.startingLoadLb ?? 0,
      targetReps: exercise.defaultRepRange,
      sets: exercise.defaultSets,
      rirBySet: rirLadder(exercise, exercise.defaultSets),
      outcome: 'first-session',
      reason: 'First session. Starting load seeded from the plan.',
    };
  }

  const lastLoad = Math.max(...last.sets.map((s) => s.addedWeightLb));

  // Entry standard: strict bodyweight reps before any load is added. The one
  // hard safety rule in the plan's loading section, and it also applies coming
  // out of a deload where the belt has been stripped back to bodyweight.
  if (
    exercise.entryStandardReps !== undefined &&
    lastLoad <= 0 &&
    !last.sets.every((s) => s.reps >= exercise.entryStandardReps!)
  ) {
    const best = Math.max(...last.sets.map((s) => s.reps));
    return {
      load: 0,
      targetReps: [exercise.entryStandardReps, exercise.entryStandardReps],
      sets: exercise.defaultSets,
      rirBySet: rirLadder(exercise, exercise.defaultSets),
      outcome: 'add-reps',
      reason: `Own ${exercise.entryStandardReps} strict bodyweight reps on every set before adding load. Best set last time was ${best}.`,
    };
  }

  // `every` is vacuously true on a single logged set, so a session cut short
  // after one good set used to earn a load increase. Require the full
  // prescribed set count before advancing.
  const completedPrescribedSets = last.sets.length >= exercise.defaultSets;
  const allHitTop = completedPrescribedSets && last.sets.every((s) => s.reps >= max);

  if (allHitTop) {
    const load = lastLoad + exercise.incrementLb;
    return {
      load,
      targetReps: exercise.defaultRepRange,
      sets: exercise.defaultSets,
      rirBySet: rirLadder(exercise, exercise.defaultSets),
      outcome: 'advance-load',
      reason: `All ${last.sets.length} sets hit ${max} reps at ${lastLoad} lb. Adding ${exercise.incrementLb} lb, back to ${min} reps.`,
    };
  }

  // The plan says "two consecutive sessions with no rep or weight progress",
  // which is TWO failed transitions and therefore needs three data points.
  // Comparing a single pair flagged a stall after one flat session, and with a
  // 2-lift threshold two flat lifts on one bad day became a fatigue signal.
  if (older && prev && !improved(older, prev) && !improved(prev, last)) {
    return {
      load: lastLoad,
      targetReps: exercise.defaultRepRange,
      sets: exercise.defaultSets,
      rirBySet: rirLadder(exercise, exercise.defaultSets),
      outcome: 'stalled',
      reason: `No rep or load gain across ${prev.date} and ${last.date}, following none across ${older.date} and ${prev.date}. Check the bodyweight trend before changing programming — at a 0.25 lb/week gain the calories are usually the cause.`,
    };
  }

  const totalReps = last.sets.reduce((a, s) => a + s.reps, 0);
  return {
    load: lastLoad,
    targetReps: exercise.defaultRepRange,
    sets: exercise.defaultSets,
    rirBySet: rirLadder(exercise, exercise.defaultSets),
    outcome: 'add-reps',
    reason: `${totalReps} total reps at ${lastLoad} lb last session. Same load, add reps toward ${max} on every set.`,
  };
}

function improved(prev: SessionPerformance, last: SessionPerformance): boolean {
  const prevLoad = Math.max(...prev.sets.map((s) => s.addedWeightLb));
  const lastLoad = Math.max(...last.sets.map((s) => s.addedWeightLb));
  if (lastLoad > prevLoad) return true;
  if (lastLoad < prevLoad) return false;
  const prevReps = prev.sets.reduce((a, s) => a + s.reps, 0);
  const lastReps = last.sets.reduce((a, s) => a + s.reps, 0);
  return lastReps > prevReps;
}

/**
 * True when the exercise has shown no gain across its two most recent sessions.
 * Used by deload trigger detection.
 */
export function isStalled(exercise: Exercise, history: readonly SessionPerformance[]): boolean {
  return nextPrescription(exercise, history).outcome === 'stalled';
}

/**
 * RIR trend at constant load: are the same numbers costing more effort?
 * Returns the change in mean RIR per session (negative = working harder), or
 * null when load varied or there is not enough history.
 */
export function rirDriftAtConstantLoad(
  history: readonly SessionPerformance[],
  minSessions = 3,
): number | null {
  const sessions = accumulationSessions(history).slice(-minSessions);
  if (sessions.length < minSessions) return null;

  const loads = sessions.map((s) => Math.max(...s.sets.map((x) => x.addedWeightLb)));
  if (new Set(loads).size !== 1) return null;

  const meanRir = sessions.map((s) => s.sets.reduce((a, x) => a + x.rir, 0) / s.sets.length);
  const n = meanRir.length;
  const meanX = (n - 1) / 2;
  const meanY = meanRir.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (meanRir[i]! - meanY);
    den += (i - meanX) ** 2;
  }
  return den === 0 ? null : num / den;
}

/** Days since a date, for scheduled-deload timing. */
export function daysSince(from: IsoDate, today: IsoDate): number {
  return daysBetween(from, today);
}

/**
 * Deload-week transform: halve the sets, 85-90% load, strip added weight from
 * bodyweight-loaded lifts entirely. Calories are deliberately NOT touched here
 * — see adjust.ts, which freezes instead.
 */
export function deloadPrescription(exercise: Exercise, normal: Prescription): Prescription {
  const load = exercise.isBodyweightLoaded ? 0 : roundTo(normal.load * 0.875, exercise.incrementLb);
  const sets = Math.max(1, Math.ceil(normal.sets / 2));
  return {
    load,
    targetReps: normal.targetReps,
    sets,
    // "Stop 4-5 reps short" is the deload instruction, and it OVERRIDES the
    // ladder. A deload that still asked for true failure on lateral raises
    // would not be a deload.
    rirBySet: Array.from({ length: sets }, () => DELOAD_RIR),
    reason: exercise.isBodyweightLoaded
      ? 'Deload week: bodyweight only, sets halved, stop 4-5 reps short.'
      : `Deload week: ~87.5% of ${normal.load} lb, sets halved, stop 4-5 reps short.`,
  };
}

/** Deload sets stop 4-5 reps short, regardless of what the ladder says. */
export const DELOAD_RIR = 4;

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}
