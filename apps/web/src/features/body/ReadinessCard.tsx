/**
 * "Here is what you have, here is what unlocks next."
 *
 * Shown until the engine has enough to act on. It exists because the first
 * month of correct behaviour is indistinguishable from a broken app: every
 * figure is an em dash and nothing says whether that is a fault or a Tuesday.
 *
 * Deliberately not a scold and not a streak. It is a parts list.
 */
import type { Readiness } from '../../lib/readiness.js';

export function ReadinessCard({ readiness }: { readiness: Readiness }) {
  if (readiness.ready) return null;

  const met = readiness.requirements.filter((r) => r.met).length;

  return (
    <section className="sheet">
      <p className="eyebrow">Not enough data yet</p>
      <h1>
        {met} of {readiness.requirements.length} ready
      </h1>
      <p className="hint">
        Every number below the fold is an em dash because the engine will not guess, not
        because anything is broken. This is what it is waiting for.
      </p>

      {readiness.nextAction && (
        <p className="reason" data-outcome="stalled">
          <strong>Next:</strong> {readiness.nextAction}
        </p>
      )}

      <div className="volume-list">
        {readiness.requirements.map((r) => {
          const pct = r.lowerIsBetter
            ? r.met
              ? 100
              : 0
            : Math.min(100, (r.have / Math.max(r.need, 1)) * 100);
          return (
            <div className="volume-row" key={r.id} data-status={r.met ? 'in-range' : 'under'}>
              <div className="volume-head">
                <span className="volume-name">{r.label}</span>
                <span className="volume-count">
                  {r.lowerIsBetter && !Number.isFinite(r.have) ? '—' : r.have}
                  <span className="muted">
                    {r.lowerIsBetter ? ` / ${r.need} max` : ` / ${r.need}`}
                  </span>
                </span>
              </div>
              <div className="volume-track">
                <span className="volume-fill" style={{ width: `${pct}%` }} />
              </div>
              {!r.met && <p className="hint">{r.unlocks}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
