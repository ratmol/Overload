/**
 * Weekly volume audit: hard sets per muscle over a rolling 7 days, against the
 * target ranges in plan.json.
 *
 * "Hard set" = a working set (non-warmup) taken to RIR <= 4. A set left 5+ reps
 * short does not drive hypertrophy meaningfully and counting it inflates the
 * audit into uselessness.
 *
 * Secondary muscles count fractionally (see MuscleContribution). Counting a row
 * as a full biceps set overstates arm volume; counting it as zero understates
 * it, which is exactly the mistake the plan warns about when it sets direct arm
 * volume near zero.
 */
import { daysBetween } from './dates.js';
import type { Exercise, IsoDate, MuscleGroup, SetLog, VolumeTarget } from './types.js';

export const HARD_SET_MAX_RIR = 4;

export interface VolumeRow {
  muscle: MuscleGroup;
  sets: number;
  min: number;
  max: number;
  status: 'under' | 'in-range' | 'over' | 'no-target';
  priority?: number;
}

export interface VolumeAuditInputs {
  today: IsoDate;
  windowDays?: number;
  sets: readonly SetLog[];
  /** date lookup for each sessionId. */
  sessionDates: ReadonlyMap<string, IsoDate>;
  exercises: readonly Exercise[];
  targets: readonly VolumeTarget[];
}

export function auditVolume(inputs: VolumeAuditInputs): VolumeRow[] {
  const windowDays = inputs.windowDays ?? 7;
  const byId = new Map(inputs.exercises.map((e) => [e.id, e]));
  const counts = new Map<MuscleGroup, number>();

  for (const set of inputs.sets) {
    if (set.isWarmup) continue;
    if (set.reps === 0) continue;
    if (set.rir > HARD_SET_MAX_RIR) continue;

    const date = inputs.sessionDates.get(set.sessionId);
    if (!date) continue;
    const age = daysBetween(date, inputs.today);
    if (age < 0 || age >= windowDays) continue;

    const exercise = byId.get(set.exerciseId);
    if (!exercise) continue;

    for (const m of exercise.muscles) {
      counts.set(m.muscle, (counts.get(m.muscle) ?? 0) + m.fraction);
    }
  }

  const rows: VolumeRow[] = [];
  const seen = new Set<MuscleGroup>();

  for (const t of inputs.targets) {
    const sets = round1(counts.get(t.muscle) ?? 0);
    seen.add(t.muscle);
    rows.push({
      muscle: t.muscle,
      sets,
      min: t.minSetsPerWeek,
      max: t.maxSetsPerWeek,
      status: sets < t.minSetsPerWeek ? 'under' : sets > t.maxSetsPerWeek ? 'over' : 'in-range',
      ...(t.priority === undefined ? {} : { priority: t.priority }),
    });
  }

  for (const [muscle, sets] of counts) {
    if (seen.has(muscle)) continue;
    rows.push({ muscle, sets: round1(sets), min: 0, max: Infinity, status: 'no-target' });
  }

  return rows.sort(
    (a, b) => (a.priority ?? 99) - (b.priority ?? 99) || a.muscle.localeCompare(b.muscle),
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
