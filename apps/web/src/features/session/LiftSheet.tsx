/**
 * One exercise, one screenful.
 *
 * The whole lift fits above the fold on a phone: prescription, what you did
 * last time, the rows you have filled in, the row you are about to fill, and
 * the pad. Nothing scrolls while a set is in progress, because scrolling with
 * chalk on your hands is how you lose your place.
 */
import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  bodyweightOn,
  deloadPrescription,
  nextPrescription,
  systemLoad,
  type Exercise,
  type IsoDate,
} from '@overload/engine';
import { db } from '../../db/db.js';
import { deleteSet, logSet, performanceHistory, setsForExerciseInSession } from '../../db/queries.js';
import { describeSets, formatSystemLoad, lb, shortDate } from '../../lib/format.js';
import { useRestTimer } from '../../lib/useRestTimer.js';
import { RestBar } from './RestBar.js';
import { go } from '../../lib/route.js';

interface PadState {
  load: number;
  reps: number;
  rir: number;
}

export function LiftSheet({
  exercise,
  sessionId,
  date,
  isDeload,
  isLast,
  onFinished,
}: {
  exercise: Exercise;
  sessionId: string;
  date: IsoDate;
  isDeload: boolean;
  isLast: boolean;
  onFinished: () => void;
}) {
  const [pad, setPad] = useState<PadState | null>(null);
  const rest = useRestTimer();

  const data = useLiveQuery(async () => {
    const [logged, history, weights] = await Promise.all([
      setsForExerciseInSession(exercise.id, sessionId),
      performanceHistory(exercise.id, { excludeSessionId: sessionId }),
      db.weights.orderBy('date').toArray(),
    ]);
    return { logged, history, bodyweight: bodyweightOn(date, weights) };
  }, [exercise.id, sessionId, date]);

  const base = data ? nextPrescription(exercise, data.history) : null;
  const prescribed = base && isDeload ? { ...base, ...deloadPrescription(exercise, base) } : base;

  // Seed the pad from the prescription once, then leave it alone — retyping a
  // load you already dialled in, because a background query re-ran, is the
  // fastest way to make a logger untrustworthy mid-set.
  useEffect(() => {
    if (pad !== null || !prescribed || !data) return;
    const lastInSession = data.logged.filter((s) => !s.isWarmup).at(-1);
    setPad({
      load: lastInSession?.addedWeightLb ?? prescribed.load,
      reps: lastInSession?.reps ?? prescribed.targetReps[1],
      rir: lastInSession?.rir ?? 2,
    });
  }, [pad, prescribed, data]);

  if (!data || !prescribed || !pad) return <div className="empty">…</div>;

  const working = data.logged.filter((s) => !s.isWarmup);
  const remaining = Math.max(0, prescribed.sets - working.length);
  const last = data.history.at(-1);
  const complete = remaining === 0;

  async function onLog() {
    await logSet({
      sessionId,
      exerciseId: exercise.id,
      addedWeightLb: pad!.load,
      reps: pad!.reps,
      rir: pad!.rir,
    });
    rest.start();
  }

  const step = (patch: Partial<PadState>) => setPad((p) => ({ ...p!, ...patch }));

  return (
    <>
      <section className="sheet">
        <div className="lift-head">
          <h2>{exercise.name}</h2>
          {isDeload && (
            <span className="badge" data-tone="mark">
              Deload
            </span>
          )}
        </div>

        <div className="prescription">
          {prescribed.sets} × {prescribed.targetReps[0]}–{prescribed.targetReps[1]}
          <span className="prescription-unit">
            @ {lb(prescribed.load)} lb{exercise.isBodyweightLoaded ? ' belt' : ''}
          </span>
        </div>

        <p className="reason" data-outcome={prescribed.outcome}>
          {prescribed.reason}
        </p>

        <table className="logbook" data-system={exercise.isBodyweightLoaded}>
          <thead>
            <tr>
              <th scope="col">Set</th>
              <th scope="col">{exercise.isBodyweightLoaded ? 'Belt' : 'Load'}</th>
              <th scope="col">Reps</th>
              <th scope="col">RIR</th>
              {/* The system column exists only where it means something. */}
              {exercise.isBodyweightLoaded && <th scope="col">System</th>}
              <th scope="col" aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {working.map((s, i) => (
              <tr key={s.id} data-state="done">
                <td>{i + 1}</td>
                <td>{lb(s.addedWeightLb)}</td>
                <td>{s.reps}</td>
                <td>{s.rir}</td>
                {exercise.isBodyweightLoaded && (
                  <td className="system">
                    {formatSystemLoad(systemLoad(exercise, s.addedWeightLb, data.bodyweight))}
                  </td>
                )}
                <td>
                  <button
                    className="set-delete"
                    aria-label={`Delete set ${i + 1}`}
                    onClick={() => void deleteSet(s.id)}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}

            {/*
              The set you are on, mirroring the pad. The only red on screen.
              It stays visible past the prescribed count, because the pad will
              happily log a fifth set and the row should agree with the button.
            */}
            <tr data-state="current">
              <td>{working.length + 1}</td>
              <td>{lb(pad.load)}</td>
              <td>{pad.reps}</td>
              <td>{pad.rir}</td>
              {exercise.isBodyweightLoaded && (
                <td className="system">
                  {formatSystemLoad(systemLoad(exercise, pad.load, data.bodyweight))}
                </td>
              )}
              <td />
            </tr>

            {/* Pre-printed rows, faint, like a form waiting to be filled in. */}
            {Array.from({ length: Math.max(0, remaining - 1) }, (_, i) => (
              <tr key={`ghost-${i}`} data-state="ghost">
                <td>{working.length + 2 + i}</td>
                <td>{lb(prescribed.load)}</td>
                <td>
                  {prescribed.targetReps[0]}–{prescribed.targetReps[1]}
                </td>
                <td>—</td>
                {exercise.isBodyweightLoaded && <td className="system" />}
                <td />
              </tr>
            ))}
          </tbody>
        </table>

        <div className="last-session">
          <span>
            {last ? `Last · ${shortDate(last.date)}` : 'No history yet'}
            {last?.isDeload ? ' (deload)' : ''}
          </span>
          <span>{last ? describeSets(last.sets) : ''}</span>
        </div>

        {exercise.isBodyweightLoaded && data.bodyweight === null && (
          <p className="hint">
            System load needs a bodyweight. Log one on the Today screen and these rows fill in.
          </p>
        )}

        <div className="btn-row">
          <button className="btn" data-tone="quiet" onClick={() => go(`/history/${exercise.id}`)}>
            History
          </button>
        </div>
      </section>

      <section className="pad" aria-label="Log a set">
        <RestBar rest={rest} />

        <div className="steppers">
          <Stepper
            label={exercise.isBodyweightLoaded ? 'Belt lb' : 'Load lb'}
            value={lb(pad.load)}
            onDown={() => step({ load: Math.max(0, pad.load - exercise.incrementLb) })}
            onUp={() => step({ load: pad.load + exercise.incrementLb })}
            downDisabled={pad.load <= 0}
          />
          <Stepper
            label="Reps"
            value={String(pad.reps)}
            onDown={() => step({ reps: Math.max(0, pad.reps - 1) })}
            onUp={() => step({ reps: pad.reps + 1 })}
            downDisabled={pad.reps <= 0}
          />
          <Stepper
            label="RIR"
            value={String(pad.rir)}
            onDown={() => step({ rir: Math.max(0, pad.rir - 1) })}
            onUp={() => step({ rir: Math.min(10, pad.rir + 1) })}
            downDisabled={pad.rir <= 0}
          />
        </div>

        {/*
          Once the prescribed sets are in, the next action is the next lift, not
          another set. Logging an extra one stays available and stays one tap —
          it is just no longer the thing the thumb lands on by default.
        */}
        {complete ? (
          <>
            <button className="log-button" onClick={onFinished}>
              {isLast ? 'Finish session' : 'Next lift →'}
            </button>
            <div className="btn-row">
              <button className="btn" data-tone="quiet" onClick={() => void onLog()}>
                Log an extra set
              </button>
            </div>
          </>
        ) : (
          <button className="log-button" onClick={() => void onLog()}>
            Log set {working.length + 1}
          </button>
        )}
      </section>
    </>
  );
}

function Stepper({
  label,
  value,
  onDown,
  onUp,
  downDisabled,
}: {
  label: string;
  value: string;
  onDown: () => void;
  onUp: () => void;
  downDisabled: boolean;
}) {
  return (
    <div className="stepper">
      <span className="stepper-label">{label}</span>
      <span className="stepper-value" aria-live="polite" aria-label={`${label} ${value}`}>
        {value}
      </span>
      <div className="stepper-buttons">
        <button onClick={onDown} disabled={downDisabled} aria-label={`${label} down`}>
          −
        </button>
        <button onClick={onUp} aria-label={`${label} up`}>
          +
        </button>
      </div>
    </div>
  );
}
