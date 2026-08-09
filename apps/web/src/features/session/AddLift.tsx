/**
 * Pick a lift that is not in today's template.
 *
 * The squat rack is taken, the cable station is broken, the gym is full. Every
 * paper logbook handles this by writing a different exercise on the line; an
 * app that cannot is an app you stop using in week two.
 *
 * Substituted lifts carry their own history, so the progression state machine
 * picks up wherever that exercise was last left off rather than starting over.
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db.js';

export function AddLift({
  excludeIds,
  onPick,
  onCancel,
}: {
  excludeIds: readonly string[];
  onPick: (exerciseId: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');

  const options = useLiveQuery(async () => {
    const all = await db.exercises.orderBy('name').toArray();
    const excluded = new Set(excludeIds);
    return all.filter((e) => !excluded.has(e.id));
  }, [excludeIds.join(',')]);

  const matches = (options ?? []).filter((e) =>
    e.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <section className="sheet">
      <p className="eyebrow">Add a lift</p>
      <div className="field">
        <label htmlFor="lift-search">Search the program</label>
        <input
          id="lift-search"
          type="search"
          autoFocus
          value={query}
          placeholder="leg press"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {matches.length === 0 ? (
        <div className="empty">Nothing matches.</div>
      ) : (
        <div className="day-list">
          {matches.slice(0, 12).map((e) => (
            <button key={e.id} className="day-row" onClick={() => onPick(e.id)}>
              <span>
                <span className="day-row-name">{e.name}</span>
                <br />
                <span className="day-row-meta">
                  {e.defaultSets} × {e.defaultRepRange[0]}–{e.defaultRepRange[1]} ·{' '}
                  {e.muscles.map((m) => m.muscle).slice(0, 3).join(', ')}
                </span>
              </span>
              <span className="day-row-go" aria-hidden="true">
                →
              </span>
            </button>
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
