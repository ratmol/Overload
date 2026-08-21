/**
 * Pick a different lift — either a straight addition, or a swap for one the
 * program prescribed.
 *
 * The squat rack is taken, the cable station is broken, the gym is full, or you
 * simply do not fancy it today. Every paper logbook handles this by writing a
 * different exercise on the line; an app that cannot is an app you stop using
 * in week two.
 *
 * Programmed alternates come first because they were chosen to hit the same
 * muscles at a similar cost — a swap that quietly halves the day's side-delt
 * volume is worse than no swap. Everything else stays reachable by search,
 * because a curated list is a guess about a gym I cannot see.
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Exercise } from '@overload/engine';
import { db } from '../../db/db.js';
import { CreateExerciseForm } from './CreateExerciseForm.js';

export function AddLift({
  title = 'Add a lift',
  preferredIds = [],
  excludeIds,
  onPick,
  onCancel,
}: {
  title?: string;
  /** Programmed alternates, best first. */
  preferredIds?: readonly string[];
  excludeIds: readonly string[];
  onPick: (exerciseId: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  // Hooks run unconditionally, every render, in the same order — that is the
  // rule, not a style preference. The create-form branch used to return
  // before this line, so flipping `creating` on changed how many hooks ran
  // between one render and the next and crashed the whole tree (React error
  // #300). The branch has to come AFTER every hook, never before one.
  const all = useLiveQuery(() => db.exercises.orderBy('name').toArray(), []);

  if (creating) {
    return (
      <CreateExerciseForm
        onCreated={(id) => {
          setCreating(false);
          onPick(id);
        }}
        onCancel={() => setCreating(false)}
      />
    );
  }

  if (!all) return <div className="empty">…</div>;

  const excluded = new Set(excludeIds);
  const byId = new Map(all.map((e) => [e.id, e]));

  const preferred = preferredIds
    .map((id) => byId.get(id))
    .filter((e): e is Exercise => !!e && !excluded.has(e.id));

  const q = query.trim().toLowerCase();
  const preferredSet = new Set(preferred.map((e) => e.id));
  const rest = all.filter(
    (e) => !excluded.has(e.id) && !preferredSet.has(e.id) && e.name.toLowerCase().includes(q),
  );

  const showPreferred = q === '' && preferred.length > 0;

  return (
    <section className="sheet">
      <p className="eyebrow">{title}</p>

      {showPreferred && (
        <>
          <p className="hint">
            Programmed alternates — same muscles, similar cost, so the week's volume holds.
          </p>
          <div className="day-list">
            {preferred.map((e) => (
              <LiftRow key={e.id} exercise={e} onPick={onPick} />
            ))}
          </div>
        </>
      )}

      <div className="field" style={{ marginTop: 'var(--s4)' }}>
        <label htmlFor="lift-search">{showPreferred ? 'Or search everything' : 'Search'}</label>
        <input
          id="lift-search"
          type="search"
          value={query}
          placeholder="leg press"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {q !== '' && rest.length === 0 && (
        <p className="hint">Nothing in the library matches &ldquo;{query}&rdquo;.</p>
      )}
      <div className="btn-row">
        <button className="btn" data-tone="quiet" type="button" onClick={() => setCreating(true)}>
          Can&rsquo;t find it? Add your own
        </button>
      </div>

      {/*
        With alternates on screen and nothing typed, the rest of the library is
        just the first six exercises in alphabetical order — noise dressed up as
        a suggestion. Show it only once there is a query to rank it by.
      */}
      {showPreferred && q === '' ? null : rest.length === 0 ? (
        <div className="empty">Nothing matches.</div>
      ) : (
        <div className="day-list">
          {rest.slice(0, 12).map((e) => (
            <LiftRow key={e.id} exercise={e} onPick={onPick} />
          ))}
        </div>
      )}

      <div className="btn-row">
        <button className="btn" data-tone="quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function LiftRow({
  exercise,
  onPick,
}: {
  exercise: Exercise;
  onPick: (id: string) => void;
}) {
  return (
    <button className="day-row" onClick={() => onPick(exercise.id)}>
      <span>
        <span className="day-row-name">
          {exercise.name}
          {exercise.custom && (
            <span className="badge day-row-badge" style={{ borderColor: 'var(--rule-strong)', color: 'var(--ink-45)' }}>
              Yours
            </span>
          )}
        </span>
        <br />
        <span className="day-row-meta">
          {exercise.defaultSets} × {exercise.defaultRepRange[0]}–{exercise.defaultRepRange[1]} ·{' '}
          {exercise.muscles
            .filter((m) => m.fraction === 1)
            .map((m) => m.muscle)
            .slice(0, 3)
            .join(', ')}
        </span>
      </span>
      <span className="day-row-go" aria-hidden="true">
        →
      </span>
    </button>
  );
}
