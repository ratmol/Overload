/**
 * The Today display order: a personal rearrangement of the day list,
 * separate from the plan's own order (which still drives `nextInRotation`).
 *
 * Runs against fake-indexeddb, same as sync-bookkeeping.test.ts.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/db.js';
import { moveTemplateInDisplayOrder, orderedTemplateIds } from '../src/db/ui-prefs.js';

const BASE = ['day-1-push', 'day-2-pull', 'day-3-legs', 'day-4-sa'];

beforeEach(async () => {
  if (!db.isOpen()) await db.open();
  await Promise.all(db.tables.map((t) => t.clear()));
});

describe('orderedTemplateIds', () => {
  it('falls back to the base order when nothing has been saved', async () => {
    expect(await orderedTemplateIds(BASE)).toEqual(BASE);
  });

  it('applies a saved arrangement', async () => {
    await db.uiPrefs.put({ id: 'current', templateOrder: ['day-3-legs', 'day-1-push'] });
    // The two moved to the front go first, in the order saved; everything
    // else keeps its original relative order, appended after.
    expect(await orderedTemplateIds(BASE)).toEqual([
      'day-3-legs',
      'day-1-push',
      'day-2-pull',
      'day-4-sa',
    ]);
  });

  it('drops a saved id the base order no longer knows about', async () => {
    await db.uiPrefs.put({ id: 'current', templateOrder: ['upper-a', 'day-2-pull'] });
    expect(await orderedTemplateIds(BASE)).toEqual([
      'day-2-pull',
      'day-1-push',
      'day-3-legs',
      'day-4-sa',
    ]);
  });

  it('appends a base id the saved arrangement has never seen', async () => {
    // A day a later plan version added, after the last time anything was
    // rearranged. Must not become invisible.
    await db.uiPrefs.put({ id: 'current', templateOrder: ['day-2-pull', 'day-1-push'] });
    expect(await orderedTemplateIds([...BASE, 'day-5-new'])).toEqual([
      'day-2-pull',
      'day-1-push',
      'day-3-legs',
      'day-4-sa',
      'day-5-new',
    ]);
  });
});

describe('moveTemplateInDisplayOrder', () => {
  it('swaps a template with its upward neighbour', async () => {
    await moveTemplateInDisplayOrder(BASE, 'day-3-legs', -1);
    expect(await orderedTemplateIds(BASE)).toEqual([
      'day-1-push',
      'day-3-legs',
      'day-2-pull',
      'day-4-sa',
    ]);
  });

  it('swaps a template with its downward neighbour', async () => {
    await moveTemplateInDisplayOrder(BASE, 'day-1-push', 1);
    expect(await orderedTemplateIds(BASE)).toEqual([
      'day-2-pull',
      'day-1-push',
      'day-3-legs',
      'day-4-sa',
    ]);
  });

  it('is a no-op moving the first item up, or the last item down', async () => {
    await moveTemplateInDisplayOrder(BASE, 'day-1-push', -1);
    await moveTemplateInDisplayOrder(BASE, 'day-4-sa', 1);
    expect(await db.uiPrefs.get('current')).toBeUndefined();
  });

  it('moving to the very front takes repeated single-step moves — "anywhere" via ▲ enough times', async () => {
    let order = BASE;
    await moveTemplateInDisplayOrder(order, 'day-4-sa', -1);
    order = await orderedTemplateIds(BASE);
    await moveTemplateInDisplayOrder(order, 'day-4-sa', -1);
    order = await orderedTemplateIds(BASE);
    await moveTemplateInDisplayOrder(order, 'day-4-sa', -1);
    order = await orderedTemplateIds(BASE);

    expect(order).toEqual(['day-4-sa', 'day-1-push', 'day-2-pull', 'day-3-legs']);
  });
});
