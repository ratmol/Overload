/**
 * The plan migration is the one place a stale row can outlive the program
 * that produced it forever, invisibly. See the comment in `db/seed.ts` for
 * the actual incident this pins: v3's rolling Upper/Lower templates survived
 * two later version bumps because `bulkPut` only upserts.
 *
 * The FIRST fix for that gated the cleanup behind `isUpgrade`, which was
 * itself wrong: a device already sitting on the current version never sees
 * `isUpgrade` go true again, so anything that picked up the stale rows
 * before the cleanup code existed would carry them forever — the exact
 * report that came back after shipping it. The "no version change" test
 * below is the one that should have caught that the first time; it did not
 * exist.
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

  it('removes a template whose id has no equivalent in the new plan, on the version bump that drops it', async () => {
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

  it('also removes a stale template with NO version bump pending — the case the first fix missed', async () => {
    // A device already sitting on the CURRENT plan version, still carrying
    // rows from a migration that happened before template cleanup existed.
    // `isUpgrade` is false here on purpose: `meta.version` already equals
    // `PLAN.version`, so nothing about this run looks like a migration.
    await db.templates.bulkPut([
      ...PLAN.templates,
      { id: 'upper-a', name: 'Upper A', exerciseIds: ['bench-press'] },
    ]);
    await db.exercises.bulkPut(PLAN.exercises);
    await db.plan.put({
      id: 'current',
      version: PLAN.version,
      name: PLAN.name,
      deloadEveryWeeks: PLAN.deloadEveryWeeks,
      templateOrder: PLAN.templates.map((t) => t.id),
      volumeTargets: PLAN.volumeTargets,
      seededAt: new Date().toISOString(),
    });

    const result = await seedIfNeeded();

    expect(result.action).toBe('seeded');
    const ids = (await db.templates.toCollection().primaryKeys()).sort();
    expect(ids).toEqual([...PLAN.templates.map((t) => t.id)].sort());
    expect(ids).not.toContain('upper-a');
  });

  it('is a no-op once a device is already clean', async () => {
    await seedIfNeeded();
    const result = await seedIfNeeded();
    expect(result.action).toBe('none');
  });
});
