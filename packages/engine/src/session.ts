/**
 * Session timing — how long you were actually in the gym.
 *
 * Wall-clock from the first WORKING set to the moment you tap finish. Warm-ups
 * do not start the clock (you ramp up, then the session begins), and the
 * rest-timer's pauses are irrelevant — a paper log only cares when the real
 * work started and when you walked out. Pure: the caller supplies the end time
 * (now, while training; the stored `finishedAt`, in history), so nothing here
 * reads the clock and every branch is testable.
 */
import type { SetLog } from './types.js';

type TimedSet = Pick<SetLog, 'timestamp' | 'isWarmup'>;

/** Timestamp of the first non-warmup set, or null when none is logged yet. */
export function firstWorkingSetAt(sets: readonly TimedSet[]): string | null {
  let earliest: string | null = null;
  for (const s of sets) {
    if (s.isWarmup) continue;
    // ISO-8601 UTC strings sort lexicographically in time order, so no Date
    // parse is needed just to find the minimum.
    if (earliest === null || s.timestamp < earliest) earliest = s.timestamp;
  }
  return earliest;
}

/**
 * Whole seconds between two ISO timestamps, never negative.
 *
 * A device clock nudged backwards between the first set and the finish would
 * otherwise report a negative session; clamping to 0 is the honest floor.
 */
export function elapsedSeconds(startIso: string, endIso: string): number {
  const seconds = (Date.parse(endIso) - Date.parse(startIso)) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
}

/**
 * Seconds in the gym: first working set → `endIso`. Null until a working set
 * exists, so the caller can show nothing rather than a zero that looks like a
 * finished, empty session.
 */
export function gymTimeSeconds(sets: readonly TimedSet[], endIso: string): number | null {
  const start = firstWorkingSetAt(sets);
  return start === null ? null : elapsedSeconds(start, endIso);
}
