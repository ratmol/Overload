/**
 * One exercise, every session, oldest at the bottom.
 *
 * System load is shown alongside belt weight on bodyweight-loaded lifts,
 * because the whole point is that the belt column can sit still for a month
 * while the system column climbs.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { bodyweightOn, systemLoad } from '@overload/engine';
import { db } from '../../db/db.js';
import { performanceHistory } from '../../db/queries.js';
import { describeSets, formatSystemLoad, shortDate } from '../../lib/format.js';
import { go } from '../../lib/route.js';

export function HistoryScreen({ exerciseId }: { exerciseId: string }) {
  const data = useLiveQuery(async () => {
    const exercise = await db.exercises.get(exerciseId);
    const history = await performanceHistory(exerciseId);
    const weights = await db.weights.orderBy('date').toArray();
    return { exercise, history, weights };
  }, [exerciseId]);

  if (!data) return <div className="empty">…</div>;
  if (!data.exercise) return <div className="empty">Unknown exercise.</div>;

  const { exercise, history, weights } = data;

  return (
    <main>
      <button className="link-back" onClick={() => window.history.back()}>
        ← Back
      </button>

      <section className="sheet">
        <p className="eyebrow">History</p>
        <h1>{exercise.name}</h1>
        <p className="muted">
          {exercise.defaultSets} × {exercise.defaultRepRange[0]}–{exercise.defaultRepRange[1]} ·{' '}
          {exercise.incrementLb} lb steps
        </p>

        {history.length === 0 ? (
          <div className="empty">Nothing logged yet.</div>
        ) : (
          [...history].reverse().map((session) => {
            const topBelt = Math.max(...session.sets.map((s) => s.addedWeightLb));
            const load = systemLoad(exercise, topBelt, bodyweightOn(session.date, weights));
            return (
              <div className="history-row" key={session.date}>
                <span className="history-date">{shortDate(session.date)}</span>
                <span className="history-sets">
                  {describeSets(session.sets)}
                  {session.isDeload ? ' · deload' : ''}
                  {exercise.isBodyweightLoaded && (
                    <>
                      <br />
                      <span className="muted">system {formatSystemLoad(load)} lb</span>
                    </>
                  )}
                </span>
              </div>
            );
          })
        )}
      </section>

      <button className="btn" data-tone="quiet" onClick={() => go('/')}>
        Today
      </button>
    </main>
  );
}
