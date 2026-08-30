import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { elapsedSeconds, firstWorkingSetAt, type Exercise, type IsoDate } from '@overload/engine';
import { db } from '../../db/db.js';
import { existingSessionId, finishSession, setSessionFlags, startSession } from '../../db/queries.js';
import { go } from '../../lib/route.js';
import { duration, longDate } from '../../lib/format.js';
import { useRestTimer } from '../../lib/useRestTimer.js';
import { LiftSheet } from './LiftSheet.js';
import { CheckIn } from './CheckIn.js';
import { AddLift } from './AddLift.js';

export function SessionScreen({ templateId, date }: { templateId: string; date: IsoDate }) {
  // `undefined` = still checking whether today's session exists; `null` =
  // checked, and it does not, because nothing has been logged yet. Opening
  // this screen must not itself create the row — see `startSession`'s
  // comment for why that used to happen and what it broke.
  const [sessionId, setSessionId] = useState<string | null | undefined>(undefined);
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

  useEffect(() => {
    let live = true;
    void existingSessionId(templateId, date).then((id) => {
      if (live) setSessionId(id);
    });
    return () => {
      live = false;
    };
  }, [templateId, date]);

  // Creates the session row on the first real write, if it does not exist
  // yet. Safe to call repeatedly — `startSession` itself is find-or-create,
  // and this just also caches the id in state once known.
  async function ensureSessionId(): Promise<string> {
    if (sessionId) return sessionId;
    const id = await startSession(templateId, date, false);
    setSessionId(id);
    return id;
  }

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

    let firstWorkAt: string | null = null;
    if (sessionId) {
      const sessionSets = await db.sets.where('sessionId').equals(sessionId).toArray();
      // The gym clock starts on the first WORKING set, not a warm-up — see
      // firstWorkingSetAt. Derived here, never stored.
      firstWorkAt = firstWorkingSetAt(sessionSets);
      for (const s of sessionSets) {
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
      firstWorkAt,
    };
  }, [templateId, sessionId, pending]);

  // The gym clock. Start is the first working set (derived above); end is now
  // while training, or the stored finish once done. A once-a-second tick keeps
  // the live number moving; it stops as soon as the session is finished.
  const firstWorkAt = data?.firstWorkAt ?? null;
  const finishedAt = data?.session?.finishedAt ?? null;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [finalSeconds, setFinalSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (!firstWorkAt || finishedAt) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [firstWorkAt, finishedAt]);

  if (data === undefined || sessionId === undefined) {
    return <div className="empty">Opening the session…</div>;
  }
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

  const gymSeconds = firstWorkAt
    ? elapsedSeconds(firstWorkAt, finishedAt ?? new Date(nowMs).toISOString())
    : null;

  // Finished: the whole screen becomes the summary — the one moment the gym
  // time is the point, not the next lift.
  if (finalSeconds !== null) {
    return (
      <main>
        <section className="sheet finish-summary">
          <p className="eyebrow">Session complete</p>
          <h1>{template.name}</h1>
          <p className="gym-time-total tnum">{duration(finalSeconds)}</p>
          <p className="hint">Time in the gym — first working set to finish, pauses included.</p>
          <button className="log-button" onClick={() => go('/')}>
            Done
          </button>
        </section>
      </main>
    );
  }

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
          {gymSeconds !== null && (
            <p className="gym-clock">
              <span className="muted">In the gym</span>{' '}
              <span className="tnum">{duration(gymSeconds)}</span>
            </p>
          )}
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={isDeload}
            onChange={(e) => {
              const isDeload = e.target.checked;
              void ensureSessionId().then((id) => setSessionFlags(id, { isDeload }));
            }}
          />
          Deload
        </label>
      </div>

      <label className="toggle toggle-inline">
        <input
          type="checkbox"
          checked={supersetsOff}
          onChange={(e) => {
            const supersetsOff = e.target.checked;
            void ensureSessionId().then((id) => setSessionFlags(id, { supersetsOff }));
          }}
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
          ensureSessionId={ensureSessionId}
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
            void ensureSessionId().then((id) => setSessionFlags(id, { swaps: next }));
            setCurrentId(replacementId ?? slot);
          }}
          onSkip={() => {
            const slot = slotFor.get(exercise.id);
            if (slot !== undefined) {
              // A programmed slot: record the skip so it stays gone for the
              // rest of today but is back on its own next time this template
              // comes up. Also drop any swap on it — nothing left to swap.
              if (!skips.includes(slot)) {
                void ensureSessionId().then((id) => setSessionFlags(id, { skips: [...skips, slot] }));
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
          onFinished={() => {
            const at = exercises.findIndex((e) => e.id === exercise.id);
            const isLastNow = at >= exercises.length - 1;
            if (!isLastNow) {
              advancePast(exercise.id);
              return;
            }
            // Finishing the last lift stamps the finish time and freezes the
            // gym-time total for the summary screen. An empty session (no
            // working set, and therefore no session row at all yet) just
            // goes home — there is no time to show.
            if (firstWorkAt && sessionId) {
              void finishSession(sessionId);
              setFinalSeconds(elapsedSeconds(firstWorkAt, new Date().toISOString()));
            } else {
              go('/');
            }
          }}
        />
      )}

      {session && <CheckIn session={session} />}
    </main>
  );
}
