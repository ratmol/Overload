/**
 * Seeds and migrates the program from data/plan.json.
 *
 * Two behaviours, and the difference matters:
 *
 * **First run** — insert everything.
 *
 * **Version bump** — overwrite the plan-owned fields on existing exercises and
 * replace the templates outright. This REVERSES the original additive-only
 * rule, which existed so a deploy could not silently revert a rep range edited
 * in the app. That protection was guarding something that does not exist:
 * there is no in-app exercise editor, so no user edit can be destroyed. What
 * the rule actually did was make program v2 undeliverable — bumping the version
 * would have added the new exercises while leaving every existing one on v1's
 * sets, reps and rest. See DECISIONS.md §18.
 *
 * What is never touched: logged sets, sessions, and exercises that have left
 * the plan. Cutting the deadlift from v2 must not orphan months of deadlifts.
 */
import { Plan } from '@overload/engine';
import planJson from '../../../../data/plan.json';
import { db } from './db.js';

/** Fails loudly at startup rather than half-seeding a malformed plan. */
export const PLAN = Plan.parse(planJson);

export interface SeedResult {
  action: 'none' | 'seeded' | 'migrated';
  fromVersion: number | null;
  toVersion: number;
  exercisesAdded: number;
  exercisesUpdated: number;
}

export async function seedIfNeeded(): Promise<SeedResult> {
  return db.transaction('rw', db.exercises, db.templates, db.plan, async () => {
    const meta = await db.plan.get('current');
    const existing = new Set(await db.exercises.toCollection().primaryKeys());

    const isFirstRun = meta === undefined;
    const isUpgrade = meta !== undefined && meta.version < PLAN.version;

    if (!isFirstRun && !isUpgrade) {
      // Still insert anything genuinely new, so a hand-added exercise in the
      // same plan version is not lost.
      const added = PLAN.exercises.filter((e) => !existing.has(e.id));
      if (added.length > 0) await db.exercises.bulkAdd(added);
      return {
        action: added.length > 0 ? 'seeded' : 'none',
        fromVersion: meta.version,
        toVersion: PLAN.version,
        exercisesAdded: added.length,
        exercisesUpdated: 0,
      };
    }

    const added = PLAN.exercises.filter((e) => !existing.has(e.id));
    const updated = PLAN.exercises.filter((e) => existing.has(e.id));

    // `put` replaces the whole row. Correct here: every field on Exercise is
    // plan-owned, so there is nothing on the stored row worth preserving.
    await db.exercises.bulkPut(PLAN.exercises);

    // Templates are replaced, not merged: v2 reorders them, drops the deadlift
    // and the curl, and swaps flat bench for incline. A merge would leave the
    // old exercise ids in place, which is the exact failure this migration
    // exists to fix.
    await db.templates.bulkPut(PLAN.templates);

    await db.plan.put({
      id: 'current',
      version: PLAN.version,
      name: PLAN.name,
      deloadEveryWeeks: PLAN.deloadEveryWeeks,
      ...(PLAN.deloadEverySessions === undefined
        ? {}
        : { deloadEverySessions: PLAN.deloadEverySessions }),
      templateOrder: PLAN.templates.map((t) => t.id),
      volumeTargets: PLAN.volumeTargets,
      seededAt: new Date().toISOString(),
    });

    return {
      action: isFirstRun ? 'seeded' : 'migrated',
      fromVersion: meta?.version ?? null,
      toVersion: PLAN.version,
      exercisesAdded: added.length,
      exercisesUpdated: isFirstRun ? 0 : updated.length,
    };
  });
}
