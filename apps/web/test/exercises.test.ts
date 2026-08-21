/**
 * Custom exercises: the id shape, and the primary/secondary fraction rule.
 * Runs against fake-indexeddb, same as sync-bookkeeping.test.ts.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/db.js';
import { createCustomExercise } from '../src/db/exercises.js';

beforeEach(async () => {
  if (!db.isOpen()) await db.open();
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('createCustomExercise', () => {
  it('marks the row custom, so it can be told apart from a plan-seeded one', async () => {
    const id = await createCustomExercise({
      name: 'Cable crunch',
      muscles: ['abs'],
      isBodyweightLoaded: false,
      incrementLb: 5,
      defaultRepRange: [12, 15],
      defaultSets: 3,
    });
    const stored = await db.exercises.get(id);
    expect(stored!.custom).toBe(true);
  });

  it('prefixes the id, so it can never collide with a plan.json id', async () => {
    // plan.json ids are short hand-picked slugs like "back-squat". A random
    // UUID alone would not collide either, but the prefix also makes a custom
    // row recognisable in a raw IndexedDB dump without opening the record.
    const id = await createCustomExercise({
      name: 'Reverse hyper',
      muscles: ['lowerBack'],
      isBodyweightLoaded: false,
      incrementLb: 5,
      defaultRepRange: [10, 15],
      defaultSets: 3,
    });
    expect(id.startsWith('custom-')).toBe(true);
  });

  it('gives the first selected muscle fraction 1, every other muscle 0.5', async () => {
    const id = await createCustomExercise({
      name: 'Landmine press',
      muscles: ['frontDelts', 'triceps', 'chest'],
      isBodyweightLoaded: false,
      incrementLb: 5,
      defaultRepRange: [8, 12],
      defaultSets: 3,
    });
    const stored = await db.exercises.get(id);
    expect(stored!.muscles).toEqual([
      { muscle: 'frontDelts', fraction: 1 },
      { muscle: 'triceps', fraction: 0.5 },
      { muscle: 'chest', fraction: 0.5 },
    ]);
  });

  it('leaves the RIR ladder, rest interval and superset group unset', async () => {
    // Every one of these has a documented fallback (RIR 2, the app's default
    // rest, no partner) — a quick add must not force filling in fields whose
    // whole point is that they are optional.
    const id = await createCustomExercise({
      name: 'Trap bar shrug',
      muscles: ['upperBack'],
      isBodyweightLoaded: false,
      incrementLb: 10,
      defaultRepRange: [10, 15],
      defaultSets: 3,
    });
    const stored = await db.exercises.get(id);
    expect(stored!.targetRirBySet).toBeUndefined();
    expect(stored!.restSeconds).toBeUndefined();
    expect(stored!.supersetGroup).toBeUndefined();
  });

  it('is immediately visible to a normal exercises query, same as any other row', async () => {
    await createCustomExercise({
      name: 'Zottman curl',
      muscles: ['biceps', 'forearms'],
      isBodyweightLoaded: false,
      incrementLb: 2.5,
      defaultRepRange: [10, 12],
      defaultSets: 3,
    });
    const all = await db.exercises.orderBy('name').toArray();
    expect(all.map((e) => e.name)).toContain('Zottman curl');
  });
});
