/**
 * `pruneEmptySessions` is the retroactive half of the "opening a day must not
 * start it" fix (see DECISIONS §31/§32). `startSession` stopped creating a
 * row on a bare look, but a device that had already opened a day or two
 * before that shipped kept the empty rows it made under the old code — each
 * one read as "in progress" on Today and had already counted toward the
 * rotation and deload timers. This is the cleanup that actually makes the
 * bug report go away, not just the prevention of new instances of it.
 *
 * Runs against fake-indexeddb, same as sync-bookkeeping.test.ts.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/db.js';
import { logSet, pruneEmptySessions, startSession } from '../src/db/queries.js';

beforeEach(async () => {
  if (!db.isOpen()) await db.open();
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('pruneEmptySessions', () => {
  it('deletes a session with no sets logged against it', async () => {
    await startSession('day-1-push', '2026-08-30', false);
    await pruneEmptySessions();
    expect(await db.sessions.count()).toBe(0);
  });

  it('keeps a session that has at least one set, warm-up or not', async () => {
    const id = await startSession('day-1-push', '2026-08-30', false);
    await logSet({
      sessionId: id,
      exerciseId: 'bench-press',
      addedWeightLb: 45,
      reps: 10,
      rir: 4,
      isWarmup: true,
    });

    await pruneEmptySessions();

    expect(await db.sessions.count()).toBe(1);
  });

  it('the exact bug report: peeking at Push and Pull leaves both empty, and both go away', async () => {
    await startSession('day-1-push', '2026-08-30', false);
    await startSession('day-2-pull', '2026-08-30', false);
    expect(await db.sessions.count()).toBe(2);

    await pruneEmptySessions();

    expect(await db.sessions.count()).toBe(0);
  });

  it('is a no-op when nothing is empty', async () => {
    const id = await startSession('day-1-push', '2026-08-30', false);
    await logSet({
      sessionId: id,
      exerciseId: 'bench-press',
      addedWeightLb: 135,
      reps: 8,
      rir: 1,
    });

    await pruneEmptySessions();
    await pruneEmptySessions();

    expect(await db.sessions.count()).toBe(1);
  });
});
