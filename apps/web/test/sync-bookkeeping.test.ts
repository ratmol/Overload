/**
 * The sync bookkeeping is the part that fails silently.
 *
 * A missed `touch` means a set you logged never reaches the other device and
 * nothing reports an error. A stray tombstone means a set you did keeps getting
 * deleted. Neither shows up in the UI, so both need tests.
 *
 * Runs against fake-indexeddb rather than a browser, because these are
 * assertions about IndexedDB semantics and Dexie transactions, not about pixels.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/db.js';
import {
  markEverythingDirty,
  pendingChanges,
  SYNCED_TABLES,
  touch,
  tombstone,
} from '../src/db/sync-bookkeeping.js';
import { deleteSet, eraseHistory, logSet, logWeight, startSession } from '../src/db/queries.js';

beforeEach(async () => {
  if (!db.isOpen()) await db.open();
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('touch and tombstone', () => {
  it('records a change as pending', async () => {
    await touch('sets', ['a', 'b']);
    const { changes } = await pendingChanges();
    expect(changes.map((c) => c.rowId).sort()).toEqual(['a', 'b']);
    expect(changes.every((c) => c.table === 'sets')).toBe(true);
  });

  it('keys by table and row, so the same id in two tables does not collide', async () => {
    await touch('sets', ['same-id']);
    await touch('weights', ['same-id']);
    const { changes } = await pendingChanges();
    expect(changes).toHaveLength(2);
    expect(changes.map((c) => c.table).sort()).toEqual(['sets', 'weights']);
  });

  it('drops the pending change when the row is deleted', async () => {
    // Otherwise a push sends both an upsert and a delete for the same id in one
    // batch, and which one wins depends on ordering nobody controls.
    await touch('sets', ['a']);
    await tombstone('sets', ['a']);
    const { changes, deletions } = await pendingChanges();
    expect(changes).toHaveLength(0);
    expect(deletions.map((d) => d.rowId)).toEqual(['a']);
  });

  it('is a no-op on an empty list', async () => {
    await touch('sets', []);
    await tombstone('sets', []);
    const { changes, deletions } = await pendingChanges();
    expect(changes).toHaveLength(0);
    expect(deletions).toHaveLength(0);
  });

  it('indexes dirty as a number, because IndexedDB keys cannot be booleans', async () => {
    // A boolean index silently matches nothing, which would make pendingChanges
    // return an empty list forever while everything looked fine.
    await touch('sets', ['a']);
    const row = await db.syncMeta.get('sets:a');
    expect(typeof row!.dirty).toBe('number');
    expect(await db.syncMeta.where('dirty').equals(1).count()).toBe(1);
  });
});

describe('the write paths record themselves', () => {
  it('records a logged set', async () => {
    const sessionId = await startSession('upper-a', '2026-08-10', false);
    const setId = await logSet({
      sessionId,
      exerciseId: 'weighted-pullup',
      addedWeightLb: 30,
      reps: 8,
      rir: 2,
    });

    const { changes } = await pendingChanges();
    expect(changes.find((c) => c.table === 'sessions' && c.rowId === sessionId)).toBeDefined();
    expect(changes.find((c) => c.table === 'sets' && c.rowId === setId)).toBeDefined();
  });

  it('records a deleted set as a deletion, not a change', async () => {
    const sessionId = await startSession('upper-a', '2026-08-10', false);
    const setId = await logSet({
      sessionId,
      exerciseId: 'weighted-pullup',
      addedWeightLb: 30,
      reps: 8,
      rir: 2,
    });
    await deleteSet(setId);

    const { changes, deletions } = await pendingChanges();
    expect(changes.some((c) => c.rowId === setId)).toBe(false);
    expect(deletions.some((d) => d.table === 'sets' && d.rowId === setId)).toBe(true);
  });

  it('records a weigh-in, and records the edit rather than a second row', async () => {
    await logWeight('2026-08-10', 132);
    await logWeight('2026-08-10', 132.4);
    const { changes } = await pendingChanges();
    const weights = changes.filter((c) => c.table === 'weights');
    expect(weights).toHaveLength(1);
    expect(await db.weights.count()).toBe(1);
  });

  it('tombstones everything erase removes', async () => {
    const sessionId = await startSession('upper-a', '2026-08-10', false);
    await logSet({ sessionId, exerciseId: 'x', addedWeightLb: 30, reps: 8, rir: 2 });
    await logWeight('2026-08-10', 132);

    await eraseHistory();

    const { deletions } = await pendingChanges();
    expect(deletions.some((d) => d.table === 'sessions')).toBe(true);
    expect(deletions.some((d) => d.table === 'sets')).toBe(true);
    expect(deletions.some((d) => d.table === 'weights')).toBe(true);
    expect(await db.sets.count()).toBe(0);
  });
});

describe('markEverythingDirty', () => {
  it('queues every existing row for upload', async () => {
    const sessionId = await startSession('upper-a', '2026-08-10', false);
    await logSet({ sessionId, exerciseId: 'x', addedWeightLb: 30, reps: 8, rir: 2 });
    await logWeight('2026-08-10', 132);
    await db.syncMeta.clear();

    await markEverythingDirty();

    const { changes } = await pendingChanges();
    expect(changes).toHaveLength(3);
  });

  it('emits NO deletions, which is what stops an import wiping other devices', async () => {
    // The single worst failure this layer could have. An import replaces the
    // local database; if that became a deletion per replaced row, restoring a
    // backup on a laptop would delete the phone's history too.
    const sessionId = await startSession('upper-a', '2026-08-10', false);
    await logSet({ sessionId, exerciseId: 'x', addedWeightLb: 30, reps: 8, rir: 2 });

    await markEverythingDirty();

    const { deletions } = await pendingChanges();
    expect(deletions).toHaveLength(0);
  });

  it('clears stale tombstones and forgets the sync position', async () => {
    await tombstone('sets', ['gone']);
    await db.syncState.put({
      id: 'current',
      lastSyncedAt: '2026-08-01T00:00:00.000Z',
      userId: 'u1',
      lastError: null,
    });

    await markEverythingDirty();

    expect(await db.tombstones.count()).toBe(0);
    expect((await db.syncState.get('current'))!.lastSyncedAt).toBeNull();
  });
});

describe('the synced surface', () => {
  it('names only tables that exist', async () => {
    const real = new Set(db.tables.map((t) => t.name));
    for (const name of SYNCED_TABLES) expect(real.has(name), name).toBe(true);
  });

  it('excludes the plan tables, which a version bump overwrites locally', async () => {
    // DECISIONS §18 rewrites exercises and templates on a plan version bump.
    // Syncing them means two devices on different app versions fight forever,
    // one pushing v3 rows and the other pushing v2.
    const synced = new Set<string>(SYNCED_TABLES);
    expect(synced.has('exercises')).toBe(false);
    expect(synced.has('templates')).toBe(false);
    expect(synced.has('plan')).toBe(false);
  });
});
