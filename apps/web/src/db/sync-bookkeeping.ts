/**
 * What changed locally, and what was deleted locally.
 *
 * Sync needs two things the app does not otherwise record: when each row last
 * changed here, and which rows have been deleted. Both are kept in their own
 * tables rather than as columns on the domain rows, for two reasons:
 *
 *  - `packages/engine` owns those shapes, and an `updatedAt` column is a
 *    persistence concern. The engine takes plain data and stays that way.
 *  - Nothing that reads training data has to learn about sync. No query grows a
 *    `where deletedAt is null`, so no screen can accidentally start showing
 *    deleted sets because someone forgot a filter.
 *
 * Deletes are recorded as TOMBSTONES and the local row really is removed. A
 * hard delete cannot sync on its own — the other device cannot tell "deleted
 * elsewhere" from "not uploaded yet", so it re-uploads the row and the deletion
 * undoes itself. The tombstone is what makes the deletion travel.
 */
import type { Table } from 'dexie';
import { db } from './db.js';

/**
 * The tables that sync.
 *
 * `exercises`, `templates` and `plan` are deliberately absent. They are seeded
 * identically on every device from data/plan.json, and DECISIONS.md §18 has a
 * migration that overwrites them on a version bump — syncing them means two
 * devices on different app versions fight forever. They stay local until the
 * program is per-user rather than global.
 */
export const SYNCED_TABLES = [
  'sessions',
  'sets',
  'weights',
  'intake',
  'adjustments',
  'foods',
  'foodLog',
  'savedMeals',
  'profile',
  'target',
] as const;

export type SyncedTable = (typeof SYNCED_TABLES)[number];

export interface SyncMeta {
  /** `${table}:${rowId}` */
  id: string;
  table: SyncedTable;
  rowId: string;
  /** When this row last changed on THIS device. */
  updatedAt: string;
  /** Waiting to be pushed. Cleared once the server has it. */
  dirty: 1 | 0;
}

export interface Tombstone {
  /** `${table}:${rowId}` */
  id: string;
  table: SyncedTable;
  rowId: string;
  deletedAt: string;
  dirty: 1 | 0;
}

export interface SyncState {
  id: 'current';
  /** Server timestamp of the last successful pull. Null = never synced. */
  lastSyncedAt: string | null;
  /** Which account the local data belongs to, once signed in. */
  userId: string | null;
  lastError: string | null;
}

const key = (table: SyncedTable, rowId: string) => `${table}:${rowId}`;

/**
 * Record that rows changed here.
 *
 * Must be called inside a transaction that includes `syncMeta` when the caller
 * is already in one — Dexie refuses cross-table writes outside the transaction
 * scope, which is a feature: it fails loudly rather than losing the record.
 */
export async function touch(table: SyncedTable, rowIds: readonly string[]): Promise<void> {
  if (rowIds.length === 0) return;
  const now = new Date().toISOString();
  await db.syncMeta.bulkPut(
    rowIds.map((rowId) => ({ id: key(table, rowId), table, rowId, updatedAt: now, dirty: 1 as const })),
  );
}

/**
 * Record that rows were deleted here.
 *
 * Also drops their syncMeta: a deleted row has nothing left to push except the
 * deletion itself, and leaving both would push a change and a delete for the
 * same id in the same batch.
 */
export async function tombstone(table: SyncedTable, rowIds: readonly string[]): Promise<void> {
  if (rowIds.length === 0) return;
  const now = new Date().toISOString();
  await db.tombstones.bulkPut(
    rowIds.map((rowId) => ({ id: key(table, rowId), table, rowId, deletedAt: now, dirty: 1 as const })),
  );
  await db.syncMeta.bulkDelete(rowIds.map((rowId) => key(table, rowId)));
}

/**
 * Everything waiting to go to the server.
 *
 * Deletions are listed separately rather than as a flag on a change, because a
 * push applies them in a different way and getting them mixed up is how a
 * deletion becomes an upsert of an empty row.
 */
export async function pendingChanges(): Promise<{
  changes: SyncMeta[];
  deletions: Tombstone[];
}> {
  const [changes, deletions] = await Promise.all([
    db.syncMeta.where('dirty').equals(1).toArray(),
    db.tombstones.where('dirty').equals(1).toArray(),
  ]);
  return { changes, deletions };
}

export async function getSyncState(): Promise<SyncState> {
  return (
    (await db.syncState.get('current')) ?? {
      id: 'current',
      lastSyncedAt: null,
      userId: null,
      lastError: null,
    }
  );
}

export async function setSyncState(patch: Partial<Omit<SyncState, 'id'>>): Promise<void> {
  await db.syncState.put({ ...(await getSyncState()), ...patch, id: 'current' });
}

/**
 * Marks every existing row as needing an upload, and forgets any prior sync
 * position.
 *
 * Two callers, both of which are "the local database is now the truth and the
 * server has not seen it":
 *
 *  - **First sign-in**, where local rows predate the account. Without this the
 *    first sync pulls nothing, pushes nothing, and looks exactly like the app
 *    wiped a year of training.
 *  - **After a JSON import**, which replaces the local database wholesale.
 *
 * An import deliberately does NOT emit tombstones for the rows it replaced. It
 * is a local restore, not a decision to delete anything, and turning it into
 * ten thousand deletions would propagate the wipe to every other device — the
 * single worst failure this whole layer could have. Remote rows the import did
 * not contain come back on the next pull, which is the safe direction: data
 * returns rather than vanishes.
 */
export async function markEverythingDirty(): Promise<void> {
  const now = new Date().toISOString();
  const rows: SyncMeta[] = [];

  for (const table of SYNCED_TABLES) {
    const ids = (await (db[table] as Table<unknown, string>).toCollection().primaryKeys()) as string[];
    for (const rowId of ids) {
      rows.push({ id: key(table, rowId), table, rowId, updatedAt: now, dirty: 1 });
    }
  }

  await db.syncMeta.clear();
  await db.syncMeta.bulkPut(rows);
  await db.tombstones.clear();
  await setSyncState({ lastSyncedAt: null });
}
