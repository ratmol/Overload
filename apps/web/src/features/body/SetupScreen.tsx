/**
 * Profile and starting target.
 *
 * Every calorie feature is gated on this, and the gate is deliberate: the
 * engine needs a goal, a rate BAND and a starting number before any of its
 * output means anything, and inventing defaults for those would be the engine
 * guessing about the user — the one thing it is built not to do.
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { UserProfile, type GoalType } from '@overload/engine';
import { getProfile, getTarget, saveProfile, setTargetManually, PROFILE_ID } from '../../db/nutrition.js';
import { go } from '../../lib/route.js';

const GOALS: { value: GoalType; label: string; band: [number, number] }[] = [
  { value: 'gain', label: 'Lean gain', band: [0.25, 0.5] },
  { value: 'maintain', label: 'Maintain', band: [-0.1, 0.1] },
  { value: 'loss', label: 'Fat loss', band: [-1, -0.5] },
];

export function SetupScreen() {
  const existing = useLiveQuery(async () => ({
    profile: await getProfile(),
    target: await getTarget(),
  }));

  const [form, setForm] = useState<{
    heightCm: string;
    birthYear: string;
    goalType: GoalType;
    bandLo: string;
    bandHi: string;
    target: string;
    minTarget: string;
    caloriesLocked: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!existing) return <div className="empty">…</div>;

  const state =
    form ??
    {
      heightCm: existing.profile ? String(existing.profile.heightCm) : '',
      birthYear: existing.profile ? String(existing.profile.birthYear) : '',
      goalType: existing.profile?.goalType ?? 'gain',
      bandLo: String(existing.profile?.targetRateBandLbPerWeek[0] ?? 0.25),
      bandHi: String(existing.profile?.targetRateBandLbPerWeek[1] ?? 0.5),
      target: existing.target ? String(existing.target.currentKcal) : '',
      minTarget: existing.profile?.minTargetKcal ? String(existing.profile.minTargetKcal) : '',
      caloriesLocked: existing.profile?.caloriesLocked ?? false,
    };

  const set = (patch: Partial<typeof state>) => {
    setSaved(false);
    setForm({ ...state, ...patch });
  };

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const parsed = UserProfile.safeParse({
      id: PROFILE_ID,
      heightCm: Number(state.heightCm),
      birthYear: Number(state.birthYear),
      unitPreference: 'imperial',
      goalType: state.goalType,
      targetRateBandLbPerWeek: [Number(state.bandLo), Number(state.bandHi)],
      caloriesLocked: state.caloriesLocked,
      medicalScreenCompletedDate: existing?.profile?.medicalScreenCompletedDate ?? null,
      ...(state.minTarget === '' ? {} : { minTargetKcal: Number(state.minTarget) }),
    });

    if (!parsed.success) {
      // The same Zod schema the engine validates against, so the app cannot
      // store a profile the engine would reject.
      setError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }

    const target = Number(state.target);
    if (!Number.isFinite(target) || target < 800) {
      setError('Starting target must be a plausible number of calories.');
      return;
    }

    const { id: _id, ...rest } = parsed.data;
    await saveProfile(rest);
    // Only reset the target when it actually changed, so re-saving the profile
    // does not wipe the baseline the drift detection depends on.
    if (existing?.target?.currentKcal !== target) await setTargetManually(target);
    setSaved(true);
  }

  const goal = GOALS.find((g) => g.value === state.goalType)!;

  return (
    <main>
      <button className="link-back" onClick={() => go('/body')}>
        ← Body
      </button>

      <section className="sheet">
        <p className="eyebrow">Setup</p>
        <h1>Profile and target</h1>
        <p className="hint">
          The engine will not estimate anything until it knows the goal and a starting number.
          It has no defaults for these on purpose — a guess here propagates into every calorie
          figure downstream.
        </p>

        <form onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="height">Height, cm</label>
            <input
              id="height"
              type="number"
              inputMode="decimal"
              value={state.heightCm}
              onChange={(e) => set({ heightCm: e.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="birth">Birth year</label>
            <input
              id="birth"
              type="number"
              inputMode="numeric"
              value={state.birthYear}
              onChange={(e) => set({ birthYear: e.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="goal">Goal</label>
            <select
              id="goal"
              value={state.goalType}
              onChange={(e) => {
                const next = GOALS.find((g) => g.value === e.target.value)!;
                set({
                  goalType: next.value,
                  bandLo: String(next.band[0]),
                  bandHi: String(next.band[1]),
                });
              }}
            >
              {GOALS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Acceptable rate, lb/week</label>
            <div className="field-pair">
              <input
                type="number"
                step="0.05"
                inputMode="decimal"
                aria-label="Rate band low"
                value={state.bandLo}
                onChange={(e) => set({ bandLo: e.target.value })}
              />
              <span className="muted">to</span>
              <input
                type="number"
                step="0.05"
                inputMode="decimal"
                aria-label="Rate band high"
                value={state.bandHi}
                onChange={(e) => set({ bandHi: e.target.value })}
              />
            </div>
            <p className="hint">
              A band, not a single number. Inside it the engine does nothing — chasing an exact
              rate means adjusting every week, because the observed rate is essentially never
              exactly equal to one number. {goal.label} defaults to {goal.band[0]} to{' '}
              {goal.band[1]}.
            </p>
          </div>

          <div className="field">
            <label htmlFor="target">Starting calorie target</label>
            <input
              id="target"
              type="number"
              inputMode="numeric"
              value={state.target}
              onChange={(e) => set({ target: e.target.value })}
            />
            <p className="hint">
              Whatever you are eating now, if you have two weeks of honest logging behind it.
              This becomes the baseline the engine measures its own drift against.
            </p>
          </div>

          <div className="field">
            <label htmlFor="floor">Floor, kcal (optional)</label>
            <input
              id="floor"
              type="number"
              inputMode="numeric"
              placeholder="1600"
              value={state.minTarget}
              onChange={(e) => set({ minTarget: e.target.value })}
            />
            <p className="hint">
              Nothing may push the target below this. Defaults to 1600 — below that the plan's
              own protein and fat minimums leave no room for training fuel.
            </p>
          </div>

          <label className="toggle">
            <input
              type="checkbox"
              checked={state.caloriesLocked}
              onChange={(e) => set({ caloriesLocked: e.target.checked })}
            />
            Lock calories — never propose a change
          </label>

          {error && <p className="hint" style={{ color: 'var(--mark)' }}>{error}</p>}
          {saved && <p className="hint">Saved.</p>}

          <div className="btn-row">
            <button className="btn" type="submit">
              Save
            </button>
            <button className="btn" data-tone="quiet" type="button" onClick={() => go('/body')}>
              Done
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
