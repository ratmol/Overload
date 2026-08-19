/**
 * A rolling program is a queue, not a calendar: "upper, lower, rest, upper,
 * lower, rest — forever, ignoring the calendar" (PROGRAM-V3.md). There is no
 * "Monday workout", only *next session*. This file answers two questions that
 * follow from that: which template is next, and whether today should be a
 * rest day instead.
 *
 * Both are recommendations, not gates — a session for a template other than
 * the recommended one is still a completely normal thing to log, the same way
 * swapping an exercise is. Nothing here prevents that.
 */
import { addDays, daysBetween } from './dates.js';
import type { IsoDate } from './types.js';

export interface RotationResult {
  /** The recommended template, or null when the plan has no rotation at all. */
  templateId: string | null;
  reason: string;
}

/**
 * The next template in the rotation, given the order the plan defines and the
 * session history.
 *
 * Looks at the most recent session whose template is actually IN the
 * rotation and advances one position, wrapping at the end. A session logged
 * against a template outside the rotation — an ad-hoc day, or a plan that has
 * since dropped that slot — is skipped rather than breaking the sequence,
 * because the rotation's whole job is to keep advancing regardless of what
 * happened on any single day.
 *
 * Deload sessions are NOT skipped: a deload week still works through the
 * rotation, just at reduced volume (see `deloadPrescription` in
 * progression.ts), so it still counts as "having done" that slot.
 */
export function nextInRotation(
  templateOrder: readonly string[],
  sessions: readonly { templateId: string; date: IsoDate }[],
): RotationResult {
  if (templateOrder.length === 0) {
    return { templateId: null, reason: 'The plan has no rotation defined.' };
  }

  // Oldest first, so "the last one" is unambiguous. Same-day ties (two
  // sessions logged on one calendar date) keep whatever order they arrived
  // in, which is an accepted simplification — training twice in one day is
  // rare enough not to warrant a real tiebreaker.
  const sorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date));

  const lastRecognized = [...sorted]
    .reverse()
    .find((s) => templateOrder.includes(s.templateId));

  if (!lastRecognized) {
    return {
      templateId: templateOrder[0]!,
      reason:
        sessions.length === 0
          ? 'First session — starting the rotation from the top.'
          : 'No session yet matches a template in the current rotation — starting from the top.',
    };
  }

  const position = templateOrder.indexOf(lastRecognized.templateId);
  const next = templateOrder[(position + 1) % templateOrder.length]!;

  return {
    templateId: next,
    reason: `Next after the last session (${lastRecognized.templateId}).`,
  };
}

/**
 * True when today would be a third consecutive training day.
 *
 * "Never three days in a row" is the one rule PROGRAM-V3.md treats as
 * non-negotiable: "the rest day is load-bearing, not optional. It is the
 * thing that stops this from becoming the problem it's meant to solve." This
 * checks for training sessions on both of the two days immediately before
 * today — a gap anywhere in those two days means the streak is already
 * broken and there is nothing to warn about.
 */
export function dueForRest(
  sessions: readonly { date: IsoDate }[],
  today: IsoDate,
): boolean {
  const dates = new Set(sessions.map((s) => s.date));
  const yesterday = addDays(today, -1);
  const dayBefore = addDays(today, -2);
  return dates.has(yesterday) && dates.has(dayBefore);
}

/**
 * Non-deload sessions on or after `blockStartDate`, for a session-counted
 * deload timer. Exported so the count that feeds `detectDeload` is itself
 * testable without a browser — the app's job is only to supply the two dates
 * and the session list, not to decide what counts.
 *
 * Inclusive of `blockStartDate` itself, which only matters on the very first
 * block: there `blockStartDate` is the date of the first session ever, and
 * that session is real accumulation work, not a boundary marker. On every
 * later block `blockStartDate` is the date of the deload that started it, and
 * that session is excluded anyway by the `isDeload` check below — so the
 * inclusive boundary is free to use in both cases without double-counting.
 */
export function accumulationSessionsSince(
  sessions: readonly { date: IsoDate; isDeload?: boolean }[],
  blockStartDate: IsoDate,
): number {
  return sessions.filter((s) => !s.isDeload && daysBetween(blockStartDate, s.date) >= 0).length;
}
