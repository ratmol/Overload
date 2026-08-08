/**
 * Deload trigger detection.
 *
 * Fires when the scheduled timer expires, OR when two or more independent
 * fatigue signals are present. Two-of-N rather than one-of-N because any single
 * signal has a high false-positive rate: one bad night's sleep is not fatigue,
 * and one stalled lift is often just a bad session.
 */
import { daysBetween } from './dates.js';
import type { IsoDate, Session } from './types.js';

export type DeloadSignal =
  | 'scheduled'
  | 'multiple-stalls'
  | 'rir-declining'
  | 'poor-sleep'
  | 'joint-pain';

export interface DeloadInputs {
  today: IsoDate;
  /** Start of the current accumulation block. */
  blockStartDate: IsoDate;
  /** From plan.json. Default 7. */
  deloadEveryWeeks: number;
  /** Exercise ids flagged stalled within the trailing 7 days. */
  stalledExerciseIds: readonly string[];
  /** Mean RIR change per session at constant load, from progression.ts. */
  rirDriftPerSession: number | null;
  /** Recent sessions, used for sleep and joint pain flags. */
  recentSessions: readonly Pick<Session, 'date' | 'sleepQuality' | 'jointPainFlag'>[];
}

export interface DeloadOptions {
  sleepQualityThreshold: number;
  sleepConsecutiveDays: number;
  jointPainConsecutiveSessions: number;
  /** RIR drift more negative than this counts as a signal. */
  rirDriftThreshold: number;
  stallCountThreshold: number;
}

export const DEFAULT_DELOAD_OPTIONS: DeloadOptions = {
  sleepQualityThreshold: 3,
  sleepConsecutiveDays: 4,
  jointPainConsecutiveSessions: 2,
  rirDriftThreshold: -0.3,
  stallCountThreshold: 2,
};

export interface DeloadRecommendation {
  recommend: boolean;
  signals: DeloadSignal[];
  reason: string;
}

export function detectDeload(
  inputs: DeloadInputs,
  options: Partial<DeloadOptions> = {},
): DeloadRecommendation {
  const o = { ...DEFAULT_DELOAD_OPTIONS, ...options };
  const signals: DeloadSignal[] = [];

  const daysIntoBlock = daysBetween(inputs.blockStartDate, inputs.today);
  const scheduled = daysIntoBlock >= inputs.deloadEveryWeeks * 7;
  if (scheduled) signals.push('scheduled');

  if (inputs.stalledExerciseIds.length >= o.stallCountThreshold) {
    signals.push('multiple-stalls');
  }

  if (inputs.rirDriftPerSession !== null && inputs.rirDriftPerSession <= o.rirDriftThreshold) {
    signals.push('rir-declining');
  }

  const sessions = [...inputs.recentSessions].sort((a, b) => a.date.localeCompare(b.date));

  const sleepRun = trailingRun(sessions, (s) =>
    s.sleepQuality === undefined ? null : s.sleepQuality < o.sleepQualityThreshold,
  );
  if (sleepRun >= o.sleepConsecutiveDays) signals.push('poor-sleep');

  const painRun = trailingRun(sessions, (s) =>
    s.jointPainFlag === undefined ? null : s.jointPainFlag,
  );
  if (painRun >= o.jointPainConsecutiveSessions) signals.push('joint-pain');

  const fatigueSignals = signals.filter((s) => s !== 'scheduled');
  const recommend = scheduled || fatigueSignals.length >= 2;

  return {
    recommend,
    signals,
    reason: buildReason(recommend, scheduled, fatigueSignals, daysIntoBlock, inputs),
  };
}

/** Length of the trailing run where `pred` is true. Unknowns break the run. */
function trailingRun<T>(items: readonly T[], pred: (item: T) => boolean | null): number {
  let run = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const v = pred(items[i]!);
    if (v === true) run++;
    else break;
  }
  return run;
}

function buildReason(
  recommend: boolean,
  scheduled: boolean,
  fatigue: readonly DeloadSignal[],
  daysIntoBlock: number,
  inputs: DeloadInputs,
): string {
  if (!recommend) {
    return fatigue.length === 1
      ? `One fatigue signal (${label(fatigue[0]!, inputs)}). Two are needed to pull a deload forward. Watch it.`
      : `Week ${Math.floor(daysIntoBlock / 7) + 1} of ${inputs.deloadEveryWeeks}. No deload indicated.`;
  }
  if (scheduled) {
    return `Scheduled deload: ${Math.floor(daysIntoBlock / 7)} weeks of accumulation complete. Halve the sets, 85-90% load, strip belt weight from dips and pull-ups, keep calories the same.`;
  }
  return `Pulling the deload forward: ${fatigue.map((s) => label(s, inputs)).join(' and ')}. Halve the sets, 85-90% load, bodyweight only on dips and pull-ups, calories unchanged.`;
}

function label(signal: DeloadSignal, inputs: DeloadInputs): string {
  switch (signal) {
    case 'multiple-stalls':
      return `${inputs.stalledExerciseIds.length} lifts stalled this week`;
    case 'rir-declining':
      return 'RIR falling at constant load (same work, more effort)';
    case 'poor-sleep':
      return 'sleep quality low for several days';
    case 'joint-pain':
      return 'joint pain across consecutive sessions';
    case 'scheduled':
      return 'scheduled timer expired';
  }
}
