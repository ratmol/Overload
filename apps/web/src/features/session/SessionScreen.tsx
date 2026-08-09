import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { IsoDate } from '@overload/engine';
import { db } from '../../db/db.js';
import { setSessionFlags, startSession } from '../../db/queries.js';
import { go } from '../../lib/route.js';
import { longDate } from '../../lib/format.js';
import { LiftSheet } from './LiftSheet.js';

export function SessionScreen({ templateId, date }: { templateId: string; date: IsoDate }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [index, setIndex] = useState(0);

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
    if (!template) return { template: null, exercises: [], session: null, setCounts: new Map() };
    const exercises = (await db.exercises.bulkGet(template.exerciseIds)).filter(
      (e): e is NonNullable<typeof e> => !!e,
    );
    const session = sessionId ? ((await db.sessions.get(sessionId)) ?? null) : null;
    const setCounts = new Map<string, number>();
    if (sessionId) {
      for (const s of await db.sets.where('sessionId').equals(sessionId).toArray()) {
        if (s.isWarmup) continue;
        setCounts.set(s.exerciseId, (setCounts.get(s.exerciseId) ?? 0) + 1);
      }
    }
    return { template, exercises, session, setCounts };
  }, [templateId, sessionId]);

  if (!data || !sessionId) return <div className="empty">Opening the session…</div>;
  if (!data.template) {
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
              onClick={() => setIndex(i)}
            >
              {e.name} <span className="rail-count">{done}/{e.defaultSets}</span>
            </button>
          );
        })}
      </nav>

      {exercise && (
        <LiftSheet
          key={exercise.id}
          exercise={exercise}
          sessionId={sessionId}
          date={date}
          isDeload={isDeload}
          isLast={index >= exercises.length - 1}
          onFinished={() => {
            if (index >= exercises.length - 1) go('/');
            else setIndex(index + 1);
          }}
        />
      )}
    </main>
  );
}
