/**
 * Deload trigger detection.
 *
 * Fires when the scheduled timer expires, OR when two or more independent
 * fatigue signals are present. Two-of-N rather than one-of-N because any single
 * signal has a high false-positive rate: one bad night's sleep is not fatigue,
 * and one stalled lift is often just a bad session.
 */
import { daysBetween, median } from './dates.js';
import type { IsoDate, Session } from './types.js';

export type DeloadSignal =
  | 'scheduled'
  | 'multiple-stalls'
  | 'rir-declining'
  | 'poor-sleep'
  | 'joint-pain'
  | 'resting-hr-elevated'
  | 'dread';

export interface DeloadInputs {
  today: IsoDate;
  /** Start of the current accumulation block. */
  blockStartDate: IsoDate;
  /** From plan.json. Default 7. */
  deloadEveryWeeks: number;
  /**
   * Session-counted scheduling, for a rolling program not tied to the
   * calendar. When BOTH this and `sessionsSinceBlockStart` are given, they
   * decide "scheduled" instead of the calendar-day check — a program built
   * around "next session, not Monday" should not have its recovery timer run
   * on a clock the program itself ignores. Omit either one to keep the
   * original calendar-day behaviour.
   */
  deloadEverySessions?: number;
  /** Non-deload sessions since `blockStartDate`. See `accumulationSessionsSince`
   *  in rotation.ts, which is what should produce this number. */
  sessionsSinceBlockStart?: number;
  /** Exercise ids flagged stalled within the trailing 7 days. */
  stalledExerciseIds: readonly string[];
  /** Mean RIR change per session at constant load, from progression.ts. */
  rirDriftPerSession: number | null;
  /** Recent sessions, used for the self-reported and wearable signals. */
  recentSessions: readonly Pick<
    Session,
    'date' | 'sleepQuality' | 'jointPainFlag' | 'restingHeartRateBpm' | 'dreadFlag'
  >[];
  /**
   * The user's normal resting heart rate. Without a personal baseline an
   * absolute bpm threshold is meaningless — a 48 bpm athlete and a 70 bpm
   * average adult are both normal.
   */
  baselineRestingHeartRateBpm?: number;
}

export interface DeloadOptions {
  sleepQualityThreshold: number;
  sleepConsecutiveDays: number;
  jointPainConsecutiveSessions: number;
  /** bpm above personal baseline that counts as a signal. */
  restingHrRiseBpm: number;
  restingHrConsecutiveSessions: number;
  /** RIR drift more negative than this counts as a signal. */
  rirDriftThreshold: number;
  stallCountThreshold: number;
}

export const DEFAULT_DELOAD_OPTIONS: DeloadOptions = {
  sleepQualityThreshold: 3,
  sleepConsecutiveDays: 4,
  jointPainConsecutiveSessions: 2,
  restingHrRiseBpm: 5,
  restingHrConsecutiveSessions: 3,
  rirDriftThreshold: -0.3,
  stallCountThreshold: 2,
};

export interface DeloadRecommendation {
  recommend: boolean;
  signals: DeloadSignal[];
  reason: string;
}

export interface RestingHrBaselineOptions {
  /**
   * Readings this recent are excluded from the baseline.
   *
   * This is the whole point of the function. A baseline computed over ALL
   * readings includes the elevated ones you are trying to detect, so it rises
   * with them and the signal can never fire — the failure mode is silent, and
   * it looks exactly like "my heart rate is fine".
   */
  excludeRecentDays: number;
  /** Below this many readings there is no personal baseline, only noise. */
  minReadings: number;
}

export const DEFAULT_RESTING_HR_BASELINE_OPTIONS: RestingHrBaselineOptions = {
  excludeRecentDays: 14,
  minReadings: 5,
};

/**
 * A personal resting heart rate baseline, in bpm, or null when there is not
 * enough history to have one.
 *
 * Median rather than mean: one bad week — illness, a redeye, a hangover —
 * should not move the number every subsequent reading is compared against.
 *
 * An absolute threshold is not usable here. A 48 bpm endurance athlete and a
 * 70 bpm average adult are both entirely normal, so the only meaningful
 * question is how far today sits above this particular person's own resting
 * rate.
 */
export function restingHrBaseline(
  sessions: readonly Pick<Session, 'date' | 'restingHeartRateBpm'>[],
  today: IsoDate,
  options: Partial<RestingHrBaselineOptions> = {},
): number | null {
  const o = { ...DEFAULT_RESTING_HR_BASELINE_OPTIONS, ...options };
  const readings = sessions
    .filter((s) => s.restingHeartRateBpm !== undefined)
    .filter((s) => {
      const age = daysBetween(s.date, today);
      return age >= o.excludeRecentDays;
    })
    .map((s) => s.restingHeartRateBpm!);

  if (readings.length < o.minReadings) return null;
  return median(readings);
}

export function detectDeload(
  inputs: DeloadInputs,
  options: Partial<DeloadOptions> = {},
): DeloadRecommendation {
  const o = { ...DEFAULT_DELOAD_OPTIONS, ...options };
  const signals: DeloadSignal[] = [];

  const daysIntoBlock = daysBetween(inputs.blockStartDate, inputs.today);
  const sessionCounted =
    inputs.deloadEverySessions !== undefined && inputs.sessionsSinceBlockStart !== undefined;
  const scheduled = sessionCounted
    ? inputs.sessionsSinceBlockStart! >= inputs.deloadEverySessions!
    : daysIntoBlock >= inputs.deloadEveryWeeks * 7;
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

  if (inputs.baselineRestingHeartRateBpm !== undefined) {
    const baseline = inputs.baselineRestingHeartRateBpm;
    const hrRun = trailingRun(sessions, (s) =>
      s.restingHeartRateBpm === undefined
        ? null
        : s.restingHeartRateBpm - baseline >= o.restingHrRiseBpm,
    );
    if (hrRun >= o.restingHrConsecutiveSessions) signals.push('resting-hr-elevated');
  }

  const dreadRun = trailingRun(sessions, (s) => (s.dreadFlag === undefined ? null : s.dreadFlag));
  if (dreadRun >= 2) signals.push('dread');

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
  const sessionCounted =
    inputs.deloadEverySessions !== undefined && inputs.sessionsSinceBlockStart !== undefined;

  if (!recommend) {
    if (fatigue.length === 1) {
      return `One fatigue signal (${label(fatigue[0]!, inputs)}). Two are needed to pull a deload forward. Watch it.`;
    }
    return sessionCounted
      ? `Session ${inputs.sessionsSinceBlockStart} of ${inputs.deloadEverySessions} this block. No deload indicated.`
      : `Week ${Math.floor(daysIntoBlock / 7) + 1} of ${inputs.deloadEveryWeeks}. No deload indicated.`;
  }
  if (scheduled) {
    const accumulation = sessionCounted
      ? `${inputs.sessionsSinceBlockStart} sessions of accumulation complete`
      : `${Math.floor(daysIntoBlock / 7)} weeks of accumulation complete`;
    return `Scheduled deload: ${accumulation}. Halve the sets, 85-90% load, strip belt weight from dips and pull-ups, keep calories the same.`;
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
    case 'resting-hr-elevated':
      return 'resting heart rate up several days running';
    case 'dread':
      return 'real dread about training, not ordinary reluctance';
    case 'scheduled':
      return 'scheduled timer expired';
  }
}
