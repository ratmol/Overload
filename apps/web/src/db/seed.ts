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

    // Templates are reconciled against the plan on EVERY load, not gated
    // behind isUpgrade. Gating it there was the actual bug in the first fix:
    // a database already sitting on the current version never sees isUpgrade
    // go true again, so a device that picked up v3's Upper/Lower rows
    // (upper-a/lower-a/upper-b/lower-b) before this reconciliation existed
    // would carry them forever even after this code shipped — the cleanup
    // would only ever fire on the NEXT version bump, not retroactively on
    // this one. Running it unconditionally, every load, fixes both the
    // already-affected devices and the next migration. `bulkPut` alone only
    // upserts and never removes a row whose id has dropped out of the plan,
    // so the delete has to happen first. Cheap — a handful of rows — and a
    // no-op once a device is actually clean.
    const keptTemplateIds = new Set(PLAN.templates.map((t) => t.id));
    const staleTemplateIds = (await db.templates.toCollection().primaryKeys()).filter(
      (id) => !keptTemplateIds.has(id as string),
    );
    if (staleTemplateIds.length > 0) await db.templates.bulkDelete(staleTemplateIds);
    await db.templates.bulkPut(PLAN.templates);

    if (!isFirstRun && !isUpgrade) {
      // Still insert anything genuinely new, so a hand-added exercise in the
      // same plan version is not lost.
      const added = PLAN.exercises.filter((e) => !existing.has(e.id));
      if (added.length > 0) await db.exercises.bulkAdd(added);
      return {
        action: added.length > 0 || staleTemplateIds.length > 0 ? 'seeded' : 'none',
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
