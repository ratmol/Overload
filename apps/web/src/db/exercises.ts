/**
 * Custom exercises — ones a person adds themselves because the library does
 * not have what their gym does.
 *
 * Deliberately NOT sync-tracked (`exercises` is outside `SYNCED_TABLES`, see
 * DECISIONS §21). That exclusion exists because a plan version bump
 * overwrites plan-seeded rows, and a custom row is never touched by that
 * migration — `seedIfNeeded` only ever `bulkPut`s the ids `plan.json`
 * defines. So a custom exercise is safe to keep locally, it just does not
 * follow you to a second device yet. Worth revisiting once the sync client
 * exists; not a reason to block adding one today.
 */
import type { Exercise, MuscleGroup } from '@overload/engine';
import { db, newId } from './db.js';

export interface NewCustomExercise {
  name: string;
  /** First = primary (fraction 1), rest = secondary (fraction 0.5). */
  muscles: MuscleGroup[];
  isBodyweightLoaded: boolean;
  incrementLb: number;
  defaultRepRange: readonly [number, number];
  defaultSets: number;
  notes?: string;
}

export async function createCustomExercise(input: NewCustomExercise): Promise<string> {
  const id = `custom-${newId()}`;
  const exercise: Exercise = {
    id,
    name: input.name,
    muscles: input.muscles.map((muscle, i) => ({ muscle, fraction: i === 0 ? 1 : 0.5 })),
    isBodyweightLoaded: input.isBodyweightLoaded,
    incrementLb: input.incrementLb,
    defaultRepRange: [input.defaultRepRange[0], input.defaultRepRange[1]],
    defaultSets: input.defaultSets,
    custom: true,
    ...(input.notes ? { notes: input.notes } : {}),
  };
  await db.exercises.add(exercise);
  return id;
}
