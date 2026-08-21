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

    const session = sessionId ? ((await db.sessions.get(sessionId)) ?? null) : null;
    const swaps = session?.swaps ?? {};
    const skips = session?.skips ?? [];

    // The template is read THROUGH the swap map rather than edited. Swapping is
    // a decision about today; next week goes back to the programmed lift on its
    // own, which is what you want when the swap was "the rack was busy". Skipped
    // slots are dropped at the same step, for the same reason — a skip is a
    // decision about today, not a template edit.
    const slots = template.exerciseIds
      .filter((id) => !skips.includes(id))
      .map((id) => ({ slotId: id, exerciseId: swaps[id] ?? id }));
    const planned = (await db.exercises.bulkGet(slots.map((s) => s.exerciseId))).filter(
      (e): e is Exercise => !!e,
    );
    const slotFor = new Map(slots.map((s) => [s.exerciseId, s.slotId]));

    const setCounts = new Map<string, number>();
    const extraIds: string[] = [];

    const plannedIds = new Set(slots.map((s) => s.exerciseId));

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
    const originals = await db.exercises.bulkGet([...new Set(Object.keys(swaps))]);
    return {
      template,
      exercises: [...planned, ...extras],
      session,
      setCounts,
      slotFor,
      swaps,
      skips,
      originalById: new Map(
        originals.filter((e): e is Exercise => !!e).map((e) => [e.id, e]),
      ),
    };
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

  const { template, exercises, session, setCounts, slotFor, swaps, skips, originalById } = data;
  const supersetsOff = session?.supersetsOff ?? false;
  const index = Math.max(
    0,
    currentId === null ? 0 : exercises.findIndex((e) => e.id === currentId),
  );
  const exercise = exercises[Math.min(index, exercises.length - 1)];
  const isDeload = session?.isDeload ?? false;

  // Same "what comes after this one" logic the finish button already uses —
  // a skip is not a different kind of done, just an earlier one.
  function advancePast(exerciseId: string) {
    const at = exercises.findIndex((e) => e.id === exerciseId);
    const next = exercises[at + 1];
    if (next) setCurrentId(next.id);
    else go('/');
  }

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

      <label className="toggle toggle-inline">
        <input
          type="checkbox"
          checked={supersetsOff}
          onChange={(e) => void setSessionFlags(sessionId, { supersetsOff: e.target.checked })}
        />
        Straight sets — no supersets today
      </label>
      {supersetsOff && (
        <p
          className="hint hint-tight"
          title="In a superset the gap between two sets of the same lift is the interval, plus the partner's set, plus the interval again. Keeping 90s while running straight would be a real cut in rest, not a neutral change."
        >
          Rest doubled to match. Expect 8–10 minutes longer.
        </p>
      )}

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
          supersetWith={
            supersetsOff || exercise.supersetGroup === undefined
              ? undefined
              : exercises.find(
                  (e) => e.id !== exercise.id && e.supersetGroup === exercise.supersetGroup,
                )
          }
          supersetsOff={supersetsOff}
          swappedFrom={(() => {
            const slot = slotFor.get(exercise.id);
            return slot && slot !== exercise.id ? originalById.get(slot) : undefined;
          })()}
          onSwap={(replacementId) => {
            const slot = slotFor.get(exercise.id) ?? exercise.id;
            const next = { ...swaps };
            if (replacementId === null || replacementId === slot) delete next[slot];
            else next[slot] = replacementId;
            void setSessionFlags(sessionId, { swaps: next });
            setCurrentId(replacementId ?? slot);
          }}
          onSkip={() => {
            const slot = slotFor.get(exercise.id);
            if (slot !== undefined) {
              // A programmed slot: record the skip so it stays gone for the
              // rest of today but is back on its own next time this template
              // comes up. Also drop any swap on it — nothing left to swap.
              if (!skips.includes(slot)) {
                void setSessionFlags(sessionId, { skips: [...skips, slot] });
              }
            } else {
              // An ad-hoc addition nobody has logged a set against yet.
              // Nothing was ever saved for it, so there is nothing to
              // record — just take it off today's rail.
              setPending((ids) => ids.filter((id) => id !== exercise.id));
            }
            advancePast(exercise.id);
          }}
          rest={rest}
          onFinished={() => advancePast(exercise.id)}
        />
      )}

      {session && <CheckIn session={session} />}
    </main>
  );
}
