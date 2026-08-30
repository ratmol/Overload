/**
 * `existingSessionId` / `startSession` is the seam that decides whether
 * opening a session screen to look around writes anything.
 *
 * It used to not be a seam at all: SessionScreen called what is now
 * `startSession` unconditionally on mount, so a session row existed the
 * instant the screen opened. That row was real data — `nextInRotation` and
 * `accumulationSessionsSince` in packages/engine both key off "a session
 * exists for this date", not off any set being logged — so backing out of a
 * day without training still advanced the rotation queue and counted toward
 * the session-counted deload timer. These tests pin the fix: looking must
 * stay free, and it must still be exactly one row per template per day once
 * something is actually logged.
 *
 * Runs against fake-indexeddb, same as sync-bookkeeping.test.ts.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/db.js';
import { existingSessionId, startSession } from '../src/db/queries.js';

beforeEach(async () => {
  if (!db.isOpen()) await db.open();
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('existingSessionId', () => {
  it('returns null for a day nothing has been logged against', async () => {
    expect(await existingSessionId('day-1-push', '2026-08-30')).toBeNull();
  });

  it('does not create a row as a side effect of looking', async () => {
    await existingSessionId('day-1-push', '2026-08-30');
    expect(await db.sessions.count()).toBe(0);
  });

  it('finds the row once one exists', async () => {
    const id = await startSession('day-1-push', '2026-08-30', false);
    expect(await existingSessionId('day-1-push', '2026-08-30')).toBe(id);
  });
});

describe('startSession', () => {
  it('is idempotent: the second call finds the first call’s row rather than duplicating it', async () => {
    const first = await startSession('day-1-push', '2026-08-30', false);
    const second = await startSession('day-1-push', '2026-08-30', false);
    expect(second).toBe(first);
    expect(await db.sessions.count()).toBe(1);
  });

  it('keeps sessions for different templates on the same day separate', async () => {
    const push = await startSession('day-1-push', '2026-08-30', false);
    const pull = await startSession('day-2-pull', '2026-08-30', false);
    expect(push).not.toBe(pull);
    expect(await db.sessions.count()).toBe(2);
  });
});
