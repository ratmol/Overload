import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Exercise, IsoDate } from '@overload/engine';
import { db } from '../../db/db.js';
import { setSessionFlags, startSession } from '../../db/queries.js';
import { go } from '../../lib/route.js';
import { longDate } from '../../lib/format.js';
import { useRestTimer } from '../../lib/useRestTimer.js';
import { LiftSheet } from './LiftSheet.js';
import { CheckIn } from './CheckIn.js';
import { AddLift } from './AddLift.js';

export function SessionScreen({ templateId, date }: { templateId: string; date: IsoDate }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /**
   * Substitutes picked this session but not yet logged against.
   *
   * Once a set exists the exercise is derived from the set rows instead, so
   * this only has to survive the gap between choosing a lift and doing it.
   */
  const [pending, setPending] = useState<string[]>([]);

  // The timer belongs to the session, not to a lift. Lift sheets are remounted
  // whenever you switch exercises, and a timer inside one used to die at
  // exactly the moment you were resting and looking at it.
  const rest = useRestTimer();

  // The session row is created on arrival rather than on the first logged set,
  // so that a session you walked out of still exists as a record of the day.
  useEffect(() => {
    let live = true;
    void startSession(templateId, date, false).then((id) => {
      if (live) setSessionId(id);
    });
    return () => {
      live = false;
    };
  }, [templateId, date]);

  const data = useLiveQuery(async () => {
    const template = await db.templates.get(templateId);
    if (!template) return null;

    const planned = (await db.exercises.bulkGet(template.exerciseIds)).filter(
      (e): e is Exercise => !!e,
    );

    const session = sessionId ? ((await db.sessions.get(sessionId)) ?? null) : null;
    const setCounts = new Map<string, number>();
    const extraIds: string[] = [];

    const plannedIds = new Set(template.exerciseIds);

    if (sessionId) {
      for (const s of await db.sets.where('sessionId').equals(sessionId).toArray()) {
        // Anything logged today that the template does not contain is a
        // substitution — the squat rack was taken, or a machine was broken. It
        // belongs on the rail, otherwise the sets exist in the database and
        // nowhere on screen.
        if (!plannedIds.has(s.exerciseId) && !extraIds.includes(s.exerciseId)) {
          extraIds.push(s.exerciseId);
        }
        if (s.isWarmup) continue;
        setCounts.set(s.exerciseId, (setCounts.get(s.exerciseId) ?? 0) + 1);
      }
    }

    for (const id of pending) {
      if (!plannedIds.has(id) && !extraIds.includes(id)) extraIds.push(id);
    }

    const extras = (await db.exercises.bulkGet(extraIds)).filter((e): e is Exercise => !!e);
    return { template, exercises: [...planned, ...extras], session, setCounts };
  }, [templateId, sessionId, pending]);

  if (data === undefined || !sessionId) return <div className="empty">Opening the session…</div>;
  if (data === null) {
    return (
      <main>
        <div className="notice">
          <strong>That day is not in the program.</strong>
          <p className="hint">The template was renamed or removed.</p>
        </div>
        <button className="btn" onClick={() => go('/')}>
          Back
        </button>
      </main>
    );
  }

  const { template, exercises, session, setCounts } = data;
  const index = Math.max(
    0,
    currentId === null ? 0 : exercises.findIndex((e) => e.id === currentId),
  );
  const exercise = exercises[Math.min(index, exercises.length - 1)];
  const isDeload = session?.isDeload ?? false;

  return (
    <main>
      <button className="link-back" onClick={() => go('/')}>
        ← Today
      </button>

      <div className="lift-head">
        <div>
          <h1>{template.name}</h1>
          <p className="day-row-meta">{longDate(date)}</p>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={isDeload}
            onChange={(e) => void setSessionFlags(sessionId, { isDeload: e.target.checked })}
          />
          Deload
        </label>
      </div>

      <nav className="rail" aria-label="Lifts in this session">
        {exercises.map((e, i) => {
          const done = setCounts.get(e.id) ?? 0;
          return (
            <button
              key={e.id}
              className="rail-chip"
              aria-current={i === index}
              data-complete={done >= e.defaultSets}
              onClick={() => setCurrentId(e.id)}
            >
              {e.name} <span className="rail-count">{done}/{e.defaultSets}</span>
            </button>
          );
        })}
        <button className="rail-chip rail-add" onClick={() => setAdding(true)}>
          + Lift
        </button>
      </nav>

      {adding && (
        <AddLift
          excludeIds={exercises.map((e) => e.id)}
          onPick={(id) => {
            setPending((ids) => (ids.includes(id) ? ids : [...ids, id]));
            setCurrentId(id);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {exercise && (
        <LiftSheet
          key={exercise.id}
          exercise={exercise}
          sessionId={sessionId}
          date={date}
          isDeload={isDeload}
          isLast={index >= exercises.length - 1}
          rest={rest}
          onFinished={() => {
            const next = exercises[index + 1];
            if (next) setCurrentId(next.id);
            else go('/');
          }}
        />
      )}

      {session && <CheckIn session={session} />}
    </main>
  );
}
