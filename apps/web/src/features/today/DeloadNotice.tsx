/**
 * Scheduled-and-fatigue deload banner.
 *
 * All of the judgement lives in `detectDeload`; this component only gathers
 * inputs and prints the reason the engine generated. If the wording here ever
 * disagrees with the engine, the engine is right.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import {
  daysBetween,
  detectDeload,
  isStalled,
  rirDriftAtConstantLoad,
  type IsoDate,
  type Session,
} from '@overload/engine';
import { db } from '../../db/db.js';
import { performanceHistory } from '../../db/queries.js';

export function DeloadNotice({
  today,
  sessions,
}: {
  today: IsoDate;
  sessions: readonly Session[];
}) {
  const recommendation = useLiveQuery(async () => {
    if (sessions.length === 0) return null;

    const plan = await db.plan.get('current');
    if (!plan) return null;

    // The current accumulation block starts the day after the last deload, or
    // at the first session ever if there has not been one.
    const lastDeload = [...sessions].reverse().find((s) => s.isDeload);
    const blockStartDate = lastDeload?.date ?? sessions[0]!.date;

    const recentSessionIds = new Set(
      sessions.filter((s) => daysBetween(s.date, today) <= 7).map((s) => s.id),
    );
    if (recentSessionIds.size === 0) return null;

    const recentSets = await db.sets.toArray();
    const recentExerciseIds = [
      ...new Set(recentSets.filter((s) => recentSessionIds.has(s.sessionId)).map((s) => s.exerciseId)),
    ];

    const stalledExerciseIds: string[] = [];
    // The engine takes one drift number; the worst lift is the right one to
    // hand it, because fatigue shows up in the lift closest to its ceiling
    // before it shows up in an average across everything.
    let worstDrift: number | null = null;

    for (const exerciseId of recentExerciseIds) {
      const exercise = await db.exercises.get(exerciseId);
      if (!exercise) continue;
      const history = await performanceHistory(exerciseId);
      if (isStalled(exercise, history)) stalledExerciseIds.push(exerciseId);
      const drift = rirDriftAtConstantLoad(history);
      if (drift !== null && (worstDrift === null || drift < worstDrift)) worstDrift = drift;
    }

    return detectDeload({
      today,
      blockStartDate,
      deloadEveryWeeks: plan.deloadEveryWeeks,
      stalledExerciseIds,
      rirDriftPerSession: worstDrift,
      recentSessions: sessions.filter((s) => daysBetween(s.date, today) <= 21),
    });
  }, [today, sessions]);

  if (!recommendation?.recommend) return null;

  return (
    <div className="notice" role="status">
      <strong>Deload week</strong>
      <p className="hint">{recommendation.reason}</p>
      <p className="hint">
        Mark the session as a deload when you start it and the prescriptions drop to match.
      </p>
    </div>
  );
}
