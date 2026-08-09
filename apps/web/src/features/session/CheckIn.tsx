/**
 * Four taps at the end of a session: sleep, joints, resting heart rate, dread.
 *
 * `detectDeload` has seven signals and four of them read these fields. Until
 * this existed the detector could only ever fire on the scheduled timer or on
 * stalled lifts — the two slowest signals it has. The three it could not see
 * are the ones that fire BEFORE performance visibly drops, which is the entire
 * reason they are in the plan.
 *
 * Everything here is optional. An unanswered question breaks the trailing run
 * rather than counting as a good day, so skipping is safe and lying is not.
 */
import { useState } from 'react';
import type { Session } from '@overload/engine';
import { setSessionFlags } from '../../db/queries.js';

export function CheckIn({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);

  const answered =
    (session.sleepQuality !== undefined ? 1 : 0) +
    (session.jointPainFlag !== undefined ? 1 : 0) +
    (session.restingHeartRateBpm !== undefined ? 1 : 0) +
    (session.dreadFlag !== undefined ? 1 : 0);

  if (!open) {
    return (
      <button className="btn check-in-open" data-tone="quiet" onClick={() => setOpen(true)}>
        Check-in {answered > 0 && <span className="muted">· {answered}/4</span>}
      </button>
    );
  }

  return (
    <section className="sheet">
      <p className="eyebrow">Check-in</p>
      <p className="hint">
        Feeds the deload detector. Two of these together pull a deload forward; one on its own
        does not, because any single signal fires too often to act on.
      </p>

      <div className="field">
        <label id="sleep-label">Sleep quality</label>
        <div className="segmented" role="group" aria-labelledby="sleep-label">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={session.sleepQuality === n}
              onClick={() => void setSessionFlags(session.id, { sleepQuality: n })}
            >
              {n}
            </button>
          ))}
        </div>
        <p className="hint">1 is wrecked, 5 is fully rested. Under 3 for four days is a signal.</p>
      </div>

      <div className="field">
        <label htmlFor="rhr">Resting heart rate, bpm</label>
        <input
          id="rhr"
          type="number"
          inputMode="numeric"
          min={20}
          max={200}
          defaultValue={session.restingHeartRateBpm ?? ''}
          onBlur={(e) => {
            const value = Number(e.target.value);
            if (Number.isFinite(value) && value >= 20 && value <= 200) {
              void setSessionFlags(session.id, { restingHeartRateBpm: value });
            }
          }}
        />
        <p className="hint">
          From this morning, off any wearable. Compared against your own baseline, not an
          absolute number — 48 and 70 are both normal for different people.
        </p>
      </div>

      <label className="toggle">
        <input
          type="checkbox"
          checked={session.jointPainFlag ?? false}
          onChange={(e) => void setSessionFlags(session.id, { jointPainFlag: e.target.checked })}
        />
        Joint pain today
      </label>

      <label className="toggle">
        <input
          type="checkbox"
          checked={session.dreadFlag ?? false}
          onChange={(e) => void setSessionFlags(session.id, { dreadFlag: e.target.checked })}
        />
        Genuine dread, not ordinary reluctance
      </label>

      <div className="btn-row">
        <button className="btn" onClick={() => setOpen(false)}>
          Done
        </button>
      </div>
    </section>
  );
}
