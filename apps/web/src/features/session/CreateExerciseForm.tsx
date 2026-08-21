/**
 * A quick form for an exercise the library does not have.
 *
 * Speed over completeness — this is meant to be filled in standing in a gym,
 * not at a desk. Muscle fractions, the RIR ladder, superset pairing and rest
 * intervals are all skippable: the engine already falls back sanely on every
 * one of them (RIR 2, no partner, the app's default rest), so a custom
 * exercise works immediately and can go unrefined forever if that is fine.
 */
import { useState } from 'react';
import { MuscleGroup, type MuscleGroup as MuscleGroupType } from '@overload/engine';
import { createCustomExercise } from '../../db/exercises.js';

const MUSCLES = MuscleGroup.options;

function muscleLabel(m: string): string {
  return m.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

export function CreateExerciseForm({
  onCreated,
  onCancel,
}: {
  onCreated: (exerciseId: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [muscles, setMuscles] = useState<MuscleGroupType[]>([]);
  const [isBodyweightLoaded, setIsBodyweightLoaded] = useState(false);
  const [sets, setSets] = useState('3');
  const [repLo, setRepLo] = useState('8');
  const [repHi, setRepHi] = useState('12');
  const [increment, setIncrement] = useState('5');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function toggleMuscle(m: MuscleGroupType) {
    setMuscles((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (name.trim() === '') return setError('Give it a name.');
    if (muscles.length === 0) return setError('Pick at least one muscle — the volume audit needs it.');

    const lo = Number(repLo);
    const hi = Number(repHi);
    const setsN = Number(sets);
    const incrementN = Number(increment);
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo <= 0 || hi < lo) {
      return setError('Rep range needs two whole numbers, low to high.');
    }
    if (!Number.isInteger(setsN) || setsN <= 0) return setError('Sets must be a whole number above zero.');
    if (!Number.isFinite(incrementN) || incrementN <= 0) return setError('The load step must be a positive number.');

    setSaving(true);
    try {
      const id = await createCustomExercise({
        name: name.trim(),
        muscles,
        isBodyweightLoaded,
        incrementLb: incrementN,
        defaultRepRange: [lo, hi],
        defaultSets: setsN,
      });
      onCreated(id);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="sheet">
      <p className="eyebrow">Add your own</p>
      <form onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="custom-name">Name</label>
          <input
            id="custom-name"
            type="text"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Whatever this gym calls it"
          />
        </div>

        <div className="field">
          <label id="custom-muscles-label">Muscles worked — first tap is primary</label>
          <div className="chip-grid" role="group" aria-labelledby="custom-muscles-label">
            {MUSCLES.map((m) => {
              const order = muscles.indexOf(m);
              return (
                <button
                  key={m}
                  type="button"
                  className="chip"
                  aria-pressed={order !== -1}
                  onClick={() => toggleMuscle(m)}
                >
                  {muscleLabel(m)}
                  {order === 0 && <span className="chip-tag">1°</span>}
                </button>
              );
            })}
          </div>
        </div>

        <label className="toggle">
          <input
            type="checkbox"
            checked={isBodyweightLoaded}
            onChange={(e) => setIsBodyweightLoaded(e.target.checked)}
          />
          Bodyweight-loaded (a pull-up, dip, or similar — tracks system load)
        </label>

        <div className="field">
          <label>Sets × rep range</label>
          <div className="field-pair">
            <input
              type="number"
              inputMode="numeric"
              aria-label="Default sets"
              value={sets}
              onChange={(e) => setSets(e.target.value)}
            />
            <input
              type="number"
              inputMode="numeric"
              aria-label="Rep range low"
              value={repLo}
              onChange={(e) => setRepLo(e.target.value)}
            />
            <input
              type="number"
              inputMode="numeric"
              aria-label="Rep range high"
              value={repHi}
              onChange={(e) => setRepHi(e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="custom-increment">Load step, lb</label>
          <input
            id="custom-increment"
            type="number"
            inputMode="decimal"
            step="0.5"
            value={increment}
            onChange={(e) => setIncrement(e.target.value)}
          />
          <p className="hint">
            {isBodyweightLoaded
              ? '2.5 is standard on a belt — a 5 lb jump is a bigger percentage swing at bodyweight than it looks.'
              : '5 for a barbell or machine stack, 2.5 for anything micro-loaded.'}
          </p>
        </div>

        {error && <p className="hint" style={{ color: 'var(--mark)' }}>{error}</p>}

        <div className="btn-row">
          <button className="btn" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Add and use it'}
          </button>
          <button className="btn" data-tone="quiet" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
