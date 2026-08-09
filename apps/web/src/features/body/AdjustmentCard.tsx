/**
 * The target, and whatever the engine currently thinks about it.
 *
 * Three states, and the middle one is the interesting one:
 *
 *  1. A proposal, with the reason, waiting to be accepted.
 *  2. A block — the engine has looked and decided not to act. The reason is
 *     shown just as prominently as a proposal would be, because "I am not
 *     confident enough to change this" is the product working, not an error.
 *  3. needs-review — good data, no response, and the engine says so instead of
 *     adding another hundred calories forever.
 *
 * Nothing applies automatically. The engine's claim is that it explains itself
 * before it changes anything, and a change applied while you slept cannot have
 * been read first.
 */
import { useState } from 'react';
import type { AdjustDecision, IsoDate } from '@overload/engine';
import type { TargetState } from '../../db/db.js';
import { acceptAdjustment } from '../../db/nutrition.js';

export function AdjustmentCard({
  today,
  target,
  decision,
}: {
  today: IsoDate;
  target: TargetState;
  decision: AdjustDecision | null;
}) {
  const [busy, setBusy] = useState(false);
  const drift = target.currentKcal - target.baselineKcal;

  return (
    <section className="sheet">
      <p className="eyebrow">Calorie target</p>
      <div className="headline">
        <span className="headline-value">{target.currentKcal}</span>
        <span className="headline-unit">kcal/day</span>
      </div>
      <p className="day-row-meta">
        Baseline {target.baselineKcal}
        {drift !== 0 && ` · moved ${drift > 0 ? '+' : ''}${drift} since`}
      </p>

      {decision === null ? (
        <p className="hint">No estimate yet, so nothing to say about the target.</p>
      ) : decision.needsReview ? (
        <div className="notice" role="status">
          <strong>This may not be a calorie problem</strong>
          <p className="hint">{decision.reason}</p>
        </div>
      ) : decision.changed ? (
        <>
          <p className="reason">{decision.reason}</p>
          <div className="proposal">
            <span className="proposal-from">{decision.previousTarget}</span>
            <span className="proposal-arrow" aria-hidden="true">
              →
            </span>
            <span className="proposal-to">{decision.newTarget}</span>
          </div>
          <div className="btn-row">
            <button
              className="log-button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void acceptAdjustment(today, decision).finally(() => setBusy(false));
              }}
            >
              Accept {decision.deltaKcal > 0 ? '+' : ''}
              {decision.deltaKcal} kcal
            </button>
          </div>
          <p className="hint">
            Nothing changes until you accept it. Ignoring a proposal is a valid answer — the
            engine will make the same case again next time it has grounds to.
          </p>
        </>
      ) : (
        <>
          <p className="reason" data-outcome={decision.blockedBy === 'in-target-band' ? undefined : 'stalled'}>
            {decision.reason}
          </p>
          <p className="hint">
            {decision.blockedBy === 'in-target-band'
              ? 'Doing nothing is the correct action here.'
              : 'The engine is refusing to act, which is usually the right call on thin data.'}
          </p>
        </>
      )}
    </section>
  );
}
