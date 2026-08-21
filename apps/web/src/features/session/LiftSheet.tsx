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
  straightSetRestSeconds,
  systemLoad,
  type Exercise,
  type IsoDate,
} from '@overload/engine';
import { db } from '../../db/db.js';
import { deleteSet, logSet, performanceHistory, setsForExerciseInSession } from '../../db/queries.js';
import { describeSets, formatSystemLoad, lb, shortDate } from '../../lib/format.js';
import type { RestTimer } from '../../lib/useRestTimer.js';
import { RestBar } from './RestBar.js';
import { AddLift } from './AddLift.js';
import { go } from '../../lib/route.js';

interface PadState {
  load: number;
  reps: number;
  rir: number;
  /**
   * Warm-ups are logged but excluded from everything that reasons about
   * training: the prescription, the stall detector, the volume audit. They are
   * recorded because ramp-up loads are worth remembering week to week, and
   * because a set you did that the log denies is how people stop trusting a
   * logger.
   */
  isWarmup: boolean;
}

export function LiftSheet({
  exercise,
  sessionId,
  date,
  isDeload,
  isLast,
  supersetWith,
  supersetsOff,
  swappedFrom,
  onSwap,
  onSkip,
  rest,
  onFinished,
}: {
  exercise: Exercise;
  sessionId: string;
  date: IsoDate;
  isDeload: boolean;
  isLast: boolean;
  /** The lift to alternate with, when this one is half of a superset. */
  supersetWith?: Exercise | undefined;
  /** Running straight sets, so rest is lengthened to compensate. */
  supersetsOff: boolean;
  /** The programmed lift this one is standing in for, if any. */
  swappedFrom?: Exercise | undefined;
  /** `null` puts the programmed lift back. */
  onSwap: (replacementId: string | null) => void;
  /**
   * Drop this exercise from today's session and move on. Only offered before
   * any working set is logged against it — once you have started, "skip" and
   * "I'm done with this one" are the same thing, and the finish button
   * already says that.
   */
  onSkip: () => void;
  /**
   * Owned by the session, not by this component.
   *
   * This sheet is remounted on every lift change (it is keyed by exercise id,
   * so the pad resets to the new prescription). A timer living here therefore
   * died the moment you moved to the next lift — which is precisely when you
   * are resting and looking at it.
   */
  rest: RestTimer;
  onFinished: () => void;
}) {
  const [pad, setPad] = useState<PadState | null>(null);
  const [swapping, setSwapping] = useState(false);

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

  // Toggling deload mid-lift changes the PRESCRIPTION (the card above the
  // pad already updates) but must also change what the pad offers to log —
  // otherwise the screen shows "2 x 6-10 @ 50 lb, RIR 4" while the pad still
  // holds the pre-deload numbers, and a tap on Log records the wrong set
  // under a label that says it is the right one. Forcing a re-seed here is
  // the one case allowed to override "seed once and leave it alone" below:
  // the prescription itself changed, not just the object identity of it.
  useEffect(() => {
    setPad(null);
  }, [isDeload]);

  // Seed the pad from the prescription once, then leave it alone — retyping a
  // load you already dialled in, because a background query re-ran, is the
  // fastest way to make a logger untrustworthy mid-set.
  useEffect(() => {
    if (pad !== null || !prescribed || !data) return;
    const done = data.logged.filter((s) => !s.isWarmup);
    const lastInSession = done.at(-1);
    setPad({
      load: lastInSession?.addedWeightLb ?? prescribed.load,
      reps: lastInSession?.reps ?? prescribed.targetReps[1],
      // Seeded from the LADDER for the set you are on, not from the last set.
      // On a 2/2/1 exercise the third set's target is 1, and defaulting to the
      // previous set's 2 would quietly turn the one hard set into another easy
      // one — which is the entire redesign, undone by a default.
      rir: prescribed.rirBySet[Math.min(done.length, prescribed.rirBySet.length - 1)] ?? 2,
      isWarmup: false,
    });
  }, [pad, prescribed, data]);

  // Show this lift's interval while idle, so a 90s superset does not read 3:00.
  // In an effect, not in render: the timer's state lives in the parent, and
  // setting it during render is a cross-component update React rejects.
  // A swapped-in lift usually has no superset group of its own, but it is
  // filling a slot that did — so the slot's grouping decides whether straight
  // sets need the longer rest, not the replacement's.
  const supersettedSlot = exercise.supersetGroup ?? swappedFrom?.supersetGroup;
  const restSeconds =
    exercise.restSeconds === undefined
      ? undefined
      : supersetsOff && supersettedSlot !== undefined
        ? straightSetRestSeconds(exercise.restSeconds)
        : exercise.restSeconds;

  const { prime } = rest;
  useEffect(() => {
    prime(restSeconds);
  }, [prime, restSeconds]);

  if (!data || !prescribed || !pad) return <div className="empty">…</div>;

  const working = data.logged.filter((s) => !s.isWarmup);
  const warmups = data.logged.filter((s) => s.isWarmup);
  const remaining = Math.max(0, prescribed.sets - working.length);
  const last = data.history.at(-1);
  const complete = remaining === 0;

  async function onLog() {
    const wasWarmup = pad!.isWarmup;
    await logSet({
      sessionId,
      exerciseId: exercise.id,
      addedWeightLb: pad!.load,
      reps: pad!.reps,
      rir: pad!.rir,
      isWarmup: wasWarmup,
    });
    // Logging a warm-up flips back to working sets, because you ramp up once
    // and then work. Leaving the toggle on is how a whole session gets logged
    // as warm-ups and silently vanishes from the volume audit.
    if (wasWarmup) setPad((p) => ({ ...p!, isWarmup: false }));
    rest.start(restSeconds);
  }

  const step = (patch: Partial<PadState>) => setPad((p) => ({ ...p!, ...patch }));

  return (
    <>
      <section className="sheet">
        <div className="lift-head">
          <h2>{exercise.name}</h2>
          <span className="badge-row">
            {supersetWith && (
              <span className="badge" title={`Alternate with ${supersetWith.name}`}>
                Superset
              </span>
            )}
            {isDeload && (
              <span className="badge" data-tone="mark">
                Deload
              </span>
            )}
          </span>
        </div>

        {supersetWith && !isDeload && (
          <p className="superset-note">
            Alternate with <strong>{supersetWith.name}</strong> — rest{' '}
            {exercise.restSeconds ?? 90}s between, not after each.
          </p>
        )}

        {swappedFrom && (
          <p className="superset-note">
            Standing in for <strong>{swappedFrom.name}</strong> today.{' '}
            <button className="link-inline" onClick={() => onSwap(null)}>
              Put it back
            </button>
          </p>
        )}

        <div className="prescription">
          {prescribed.sets} × {prescribed.targetReps[0]}–{prescribed.targetReps[1]}
          <span className="prescription-unit">
            @ {lb(prescribed.load)} lb{exercise.isBodyweightLoaded ? ' belt' : ''}
          </span>
        </div>

        <RirLadder rir={prescribed.rirBySet} done={working.length} />

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
            {/* Warm-ups sit above the working sets and are numbered W, because
                they happened first and count for nothing. */}
            {warmups.map((s, i) => (
              <tr key={s.id} data-state="warmup">
                <td>W{i + 1}</td>
                <td>{lb(s.addedWeightLb)}</td>
                <td>{s.reps}</td>
                <td>—</td>
                {exercise.isBodyweightLoaded && <td className="system" />}
                <td>
                  <button
                    className="set-delete"
                    aria-label={`Delete warm-up ${i + 1}`}
                    onClick={() => void deleteSet(s.id)}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}

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
              <td>{pad.isWarmup ? `W${warmups.length + 1}` : working.length + 1}</td>
              <td>{lb(pad.load)}</td>
              <td>{pad.reps}</td>
              <td>{pad.isWarmup ? '—' : pad.rir}</td>
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
                <td>{prescribed.rirBySet[working.length + 1 + i] ?? '—'}</td>
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
          <button className="btn" data-tone="quiet" onClick={() => setSwapping((v) => !v)}>
            {swapping ? 'Cancel swap' : 'Swap'}
          </button>
          <button className="btn" data-tone="quiet" onClick={() => go(`/history/${exercise.id}`)}>
            History
          </button>
          {working.length === 0 && (
            <button
              className="btn"
              data-tone="quiet"
              onClick={() => {
                if (window.confirm(`Skip ${exercise.name} for today? It's back next time.`)) {
                  onSkip();
                }
              }}
            >
              Skip today
            </button>
          )}
        </div>
      </section>

      {swapping && (
        <AddLift
          title={`Swap ${exercise.name}`}
          preferredIds={exercise.alternates ?? []}
          excludeIds={[exercise.id]}
          onPick={(id) => {
            setSwapping(false);
            onSwap(id);
          }}
          onCancel={() => setSwapping(false)}
        />
      )}

      <section className="pad" aria-label="Log a set">
        <RestBar rest={rest} />

        <div className="steppers">
          <Stepper
            label={exercise.isBodyweightLoaded ? 'Belt lb' : 'Load lb'}
            value={pad.load}
            display={lb(pad.load)}
            step={exercise.incrementLb}
            onChange={(load) => step({ load })}
            onDown={() => step({ load: Math.max(0, pad.load - exercise.incrementLb) })}
            onUp={() => step({ load: pad.load + exercise.incrementLb })}
            downDisabled={pad.load <= 0}
          />
          <Stepper
            label="Reps"
            value={pad.reps}
            step={1}
            onChange={(reps) => step({ reps: Math.round(reps) })}
            onDown={() => step({ reps: Math.max(0, pad.reps - 1) })}
            onUp={() => step({ reps: pad.reps + 1 })}
            downDisabled={pad.reps <= 0}
          />
          <Stepper
            label="RIR"
            value={pad.rir}
            {...(pad.isWarmup ? { display: '—' } : {})}
            step={1}
            disabled={pad.isWarmup}
            onChange={(rir) => step({ rir: Math.min(10, Math.round(rir)) })}
            onDown={() => step({ rir: Math.max(0, pad.rir - 1) })}
            onUp={() => step({ rir: Math.min(10, pad.rir + 1) })}
            downDisabled={pad.rir <= 0}
          />
        </div>

        <label className="toggle toggle-inline">
          <input
            type="checkbox"
            checked={pad.isWarmup}
            onChange={(e) => step({ isWarmup: e.target.checked })}
          />
          Warm-up — logged, but counts toward nothing
        </label>

        {/*
          Once the prescribed sets are in, the next action is the next lift, not
          another set. Logging an extra one stays available and stays one tap —
          it is just no longer the thing the thumb lands on by default.
        */}
        {complete && !pad.isWarmup ? (
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
            {pad.isWarmup ? `Log warm-up ${warmups.length + 1}` : `Log set ${working.length + 1}`}
          </button>
        )}
      </section>
    </>
  );
}

/**
 * The ladder, printed as a row of rungs.
 *
 * This is the one number that explains why a 19-set session is survivable, and
 * before it existed the app prescribed the sets while losing the reason. The
 * set you are on is marked; a 0 is labelled, because "RIR 0" and "failure" are
 * the same instruction and only one of them reads as an instruction.
 */
function RirLadder({ rir, done }: { rir: readonly number[]; done: number }) {
  return (
    <div className="rir-ladder">
      <span className="rir-label">RIR</span>
      {rir.map((r, i) => (
        <span
          key={i}
          className="rir-rung"
          data-state={i < done ? 'done' : i === done ? 'current' : 'todo'}
          data-failure={r === 0}
        >
          {r === 0 ? 'F' : r}
        </span>
      ))}
      <span className="rir-hint">
        {rir.every((r) => r === 0)
          ? 'true failure, every set'
          : rir.some((r) => r === 0)
            ? 'F = to failure'
            : `last set stops at ${Math.min(...rir)}`}
      </span>
    </div>
  );
}

function Stepper({
  label,
  value,
  display,
  step,
  onChange,
  onDown,
  onUp,
  downDisabled,
  upDisabled = false,
  disabled = false,
}: {
  label: string;
  value: number;
  display?: string;
  step: number;
  onChange: (next: number) => void;
  onDown: () => void;
  onUp: () => void;
  downDisabled: boolean;
  upDisabled?: boolean;
  disabled?: boolean;
}) {
  // Held as a string while focused so half-typed input survives. Committing on
  // every keystroke would turn "12" into 1 then 12, and a bare "." or "" into
  // NaN — which is how a logger ends up recording a set you did not do.
  const [draft, setDraft] = useState<string | null>(null);

  function commit(raw: string) {
    setDraft(null);
    const parsed = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(parsed) && parsed >= 0) onChange(parsed);
  }

  return (
    <div className="stepper">
      <label className="stepper-label" htmlFor={`stepper-${label}`}>
        {label}
      </label>
      <input
        id={`stepper-${label}`}
        className="stepper-value"
        // `text` rather than `number`: the numeric keypad comes from inputMode,
        // and type=number adds spinners and silently discards input the browser
        // considers partial.
        type="text"
        inputMode="decimal"
        disabled={disabled}
        value={draft ?? display ?? String(value)}
        onFocus={(e) => {
          setDraft(String(value));
          // Select-all so the first keystroke replaces rather than appends —
          // typing 60 into a field showing 50 must not give 5060.
          requestAnimationFrame(() => e.target.select());
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
      <div className="stepper-buttons">
        <button onClick={onDown} disabled={disabled || downDisabled} aria-label={`${label} down ${step}`}>
          −
        </button>
        <button onClick={onUp} disabled={disabled || upDisabled} aria-label={`${label} up ${step}`}>
          +
        </button>
      </div>
    </div>
  );
}
