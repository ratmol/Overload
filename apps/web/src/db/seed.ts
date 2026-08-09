/**
 * Seeds the program from data/plan.json on first run.
 *
 * Seeding is additive, never destructive. On a plan.json version bump, new
 * exercises and templates are inserted and existing rows are left alone —
 * because a rep range edited in the app is a decision, and a deploy is not a
 * reason to reverse it. Removing an exercise from the plan does not delete the
 * sets logged against it either; history stays readable.
 */
import { Plan } from '@overload/engine';
import planJson from '../../../../data/plan.json';
import { db } from './db.js';

/** Fails loudly at startup rather than half-seeding a malformed plan. */
export const PLAN = Plan.parse(planJson);

export async function seedIfNeeded(): Promise<void> {
  await db.transaction('rw', db.exercises, db.templates, db.plan, async () => {
    const existingExercises = new Set(await db.exercises.toCollection().primaryKeys());
    const newExercises = PLAN.exercises.filter((e) => !existingExercises.has(e.id));
    if (newExercises.length > 0) await db.exercises.bulkAdd(newExercises);

    const existingTemplates = new Set(await db.templates.toCollection().primaryKeys());
    const newTemplates = PLAN.templates.filter((t) => !existingTemplates.has(t.id));
    if (newTemplates.length > 0) await db.templates.bulkAdd(newTemplates);

    await db.plan.put({
      id: 'current',
      version: PLAN.version,
      name: PLAN.name,
      deloadEveryWeeks: PLAN.deloadEveryWeeks,
      templateOrder: PLAN.templates.map((t) => t.id),
      volumeTargets: PLAN.volumeTargets,
      seededAt: new Date().toISOString(),
    });
  });
}
