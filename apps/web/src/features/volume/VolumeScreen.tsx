/**
 * Weekly volume audit: hard sets per muscle over a rolling 7 days.
 *
 * A hard set is a working set at RIR 4 or less. Secondaries count 0.5. Both
 * thresholds are the engine's, both are judgement calls, and both are recorded
 * in DECISIONS.md §9 — the audit is only useful if it can tell a hard week from
 * a lazy one, and only honest if row work counts for something toward biceps
 * without pretending to be curls.
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { auditVolume, type VolumeRow } from '@overload/engine';
import { db } from '../../db/db.js';
import { todayIso } from '../../db/queries.js';
import { PLAN } from '../../db/seed.js';
import { go } from '../../lib/route.js';

const WINDOWS = [7, 14] as const;

/** camelCase muscle keys are data, not display text. */
function label(muscle: string): string {
  return muscle
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

export function VolumeScreen() {
  const today = todayIso();
  const [windowDays, setWindowDays] = useState<(typeof WINDOWS)[number]>(7);

  const rows = useLiveQuery(async () => {
    const [sets, sessions, exercises] = await Promise.all([
      db.sets.toArray(),
      db.sessions.toArray(),
      db.exercises.toArray(),
    ]);
    return auditVolume({
      today,
      windowDays,
      sets,
      sessionDates: new Map(sessions.map((s) => [s.id, s.date])),
      exercises,
      targets: PLAN.volumeTargets,
    });
  }, [today, windowDays]);

  if (!rows) return <div className="empty">…</div>;

  const under = rows.filter((r) => r.status === 'under' && r.priority !== undefined);

  return (
    <main>
      <button className="link-back" onClick={() => go('/')}>
        ← Today
      </button>

      <section className="sheet">
        <p className="eyebrow">Volume</p>
        <h1>Hard sets per muscle</h1>

        <div className="segmented">
          {WINDOWS.map((w) => (
            <button key={w} type="button" aria-pressed={windowDays === w} onClick={() => setWindowDays(w)}>
              {w} days
            </button>
          ))}
        </div>

        {under.length > 0 && (
          <p className="reason" data-outcome="stalled">
            Under target on {under.map((r) => label(r.muscle).toLowerCase()).join(', ')} — the
            priority {under.map((r) => r.priority).join('/')} {under.length === 1 ? 'lever' : 'levers'} in
            the plan. These are the ones worth fixing first.
          </p>
        )}

        <div className="volume-list">
          {rows
            .filter((r) => r.status !== 'no-target')
            .map((row) => (
              <VolumeBar key={row.muscle} row={row} />
            ))}
        </div>

        <p className="hint">
          A hard set is a working set taken to RIR 4 or less; anything easier does not count.
          Secondary muscles count half a set, so rows contribute to biceps without pretending to
          be direct arm work.
        </p>
      </section>
    </main>
  );
}

function VolumeBar({ row }: { row: VolumeRow }) {
  // The bar is scaled to the target ceiling, not to the largest value on
  // screen, so "12 of a 6-12 range" always looks full and always means the
  // same thing week to week.
  const scale = Math.max(row.max, row.sets, 1);
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;

  return (
    <div className="volume-row" data-status={row.status}>
      <div className="volume-head">
        <span className="volume-name">
          {label(row.muscle)}
          {row.priority !== undefined && <span className="volume-priority">P{row.priority}</span>}
        </span>
        <span className="volume-count">
          {row.sets} <span className="muted">/ {row.min}–{row.max}</span>
        </span>
      </div>
      <div className="volume-track">
        {/* The target band, printed behind the bar like a range on a form. */}
        <span
          className="volume-band"
          style={{ left: pct(row.min), width: `calc(${pct(row.max)} - ${pct(row.min)})` }}
        />
        <span className="volume-fill" style={{ width: pct(row.sets) }} />
      </div>
    </div>
  );
}
