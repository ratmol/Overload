/**
 * The plan migration is the one place a stale row can outlive the program
 * that produced it forever, invisibly. See the comment in `db/seed.ts` for
 * the actual incident this pins: v3's rolling Upper/Lower templates survived
 * two later version bumps because `bulkPut` only upserts.
 *
 * Runs against fake-indexeddb, same as sync-bookkeeping.test.ts.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/db.js';
import { PLAN, seedIfNeeded } from '../src/db/seed.js';

beforeEach(async () => {
  if (!db.isOpen()) await db.open();
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('seedIfNeeded', () => {
  it('inserts every current-plan template on a first run', async () => {
    await seedIfNeeded();
    const ids = (await db.templates.toCollection().primaryKeys()).sort();
    expect(ids).toEqual([...PLAN.templates.map((t) => t.id)].sort());
  });

  it('removes a template whose id has no equivalent in the new plan', async () => {
    // Simulate a database left over from an old plan version: the real
    // pre-v6 shape had four rolling Upper/Lower templates with ids that do
    // not exist anywhere in the current plan.
    await db.templates.bulkPut([
      { id: 'upper-a', name: 'Upper A', exerciseIds: ['bench-press'] },
      { id: 'lower-a', name: 'Lower A', exerciseIds: ['back-squat'] },
    ]);
    await db.exercises.bulkPut(PLAN.exercises);
    await db.plan.put({
      id: 'current',
      version: PLAN.version - 1,
      name: 'old plan',
      deloadEveryWeeks: PLAN.deloadEveryWeeks,
      templateOrder: ['upper-a', 'lower-a'],
      volumeTargets: PLAN.volumeTargets,
      seededAt: new Date().toISOString(),
    });

    const result = await seedIfNeeded();

    expect(result.action).toBe('migrated');
    const ids = (await db.templates.toCollection().primaryKeys()).sort();
    expect(ids).toEqual([...PLAN.templates.map((t) => t.id)].sort());
    expect(ids).not.toContain('upper-a');
    expect(ids).not.toContain('lower-a');
  });

  it('leaves templates alone when the plan version has not changed', async () => {
    await seedIfNeeded();
    // A hand-added template from outside the plan (there is no in-app editor
    // for this today, but the migration must not assume there never will be).
    await db.templates.add({ id: 'ad-hoc', name: 'Ad hoc day', exerciseIds: ['bench-press'] });

    await seedIfNeeded();

    const ids = (await db.templates.toCollection().primaryKeys()).sort();
    expect(ids).toContain('ad-hoc');
  });
});
