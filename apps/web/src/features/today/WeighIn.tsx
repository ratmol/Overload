/**
 * Bodyweight for one day.
 *
 * The only reason this exists at Stage 1: system load on pull-ups and dips is
 * `bodyweight + belt`, and without a recent weight the app has to print "—".
 * No trend, no average, no calories — the number is here to do the logger's own
 * job, and the analysis of it belongs to the engine, later.
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { bodyweightOn, daysBetween, type IsoDate } from '@overload/engine';
import { db } from '../../db/db.js';
import { logWeight } from '../../db/queries.js';
import { lb, UNKNOWN } from '../../lib/format.js';

export function WeighIn({ date }: { date: IsoDate }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const weights = useLiveQuery(() => db.weights.orderBy('date').toArray(), []);
  if (!weights) return null;

  const todays = weights.find((w) => w.date === date);
  const carried = bodyweightOn(date, weights);
  const source = weights.filter((w) => w.date <= date).at(-1);
  const staleDays = source ? daysBetween(source.date, date) : null;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const value = Number(draft);
    if (!Number.isFinite(value) || value <= 0) return;
    await logWeight(date, value);
    setEditing(false);
    setDraft('');
  }

  if (editing) {
    return (
      <section className="sheet">
        <form onSubmit={save}>
          <div className="field">
            <label htmlFor="weight">Bodyweight, lb</label>
            <input
              id="weight"
              type="number"
              inputMode="decimal"
              step="0.1"
              min="1"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={carried === null ? '' : lb(carried)}
            />
          </div>
          <div className="btn-row">
            <button className="btn" type="submit">
              Save
            </button>
            <button
              className="btn"
              data-tone="quiet"
              type="button"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      </section>
    );
  }

  return (
    <section className="sheet">
      <div className="weighin">
        <div>
          <p className="eyebrow">Bodyweight</p>
          <p className="weighin-value" data-empty={carried === null}>
            {carried === null ? UNKNOWN : `${lb(carried)} lb`}
          </p>
          <p className="day-row-meta">
            {todays
              ? 'Logged today'
              : carried === null
                ? 'Pull-ups and dips show — until this is set'
                : `Carried from ${staleDays} ${staleDays === 1 ? 'day' : 'days'} ago`}
          </p>
        </div>
        <button
          className="btn"
          data-tone={todays ? 'quiet' : undefined}
          onClick={() => {
            setDraft(todays ? String(todays.weightLb) : '');
            setEditing(true);
          }}
        >
          {todays ? 'Edit' : 'Log'}
        </button>
      </div>
    </section>
  );
}
