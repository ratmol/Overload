/**
 * JSON export and import.
 *
 * This is the whole answer to "what if I lose the phone". There is no server,
 * so the export file IS the backup, and an import that does not round-trip
 * exactly is data loss with extra steps. Every row is validated against the
 * engine's Zod schemas on the way back in — the same schemas that guard the
 * engine — so a hand-edited or truncated file is rejected whole rather than
 * applied halfway.
 */
import { z } from 'zod';
import {
  Exercise,
  Session,
  SessionTemplate,
  SetLog,
  UserProfile,
  WeightEntry,
} from '@overload/engine';
import { db } from './db.js';

export const BACKUP_FORMAT = 1;

const Backup = z.object({
  format: z.literal(BACKUP_FORMAT),
  exportedAt: z.string(),
  app: z.literal('overload'),
  exercises: z.array(Exercise),
  templates: z.array(SessionTemplate),
  sessions: z.array(Session),
  sets: z.array(SetLog),
  weights: z.array(WeightEntry),
  profile: z.array(UserProfile),
});
export type Backup = z.infer<typeof Backup>;

export async function exportAll(): Promise<Backup> {
  const [exercises, templates, sessions, sets, weights, profile] = await Promise.all([
    db.exercises.toArray(),
    db.templates.toArray(),
    db.sessions.toArray(),
    db.sets.toArray(),
    db.weights.toArray(),
    db.profile.toArray(),
  ]);
  return {
    format: BACKUP_FORMAT,
    app: 'overload',
    exportedAt: new Date().toISOString(),
    exercises,
    templates,
    sessions,
    sets,
    weights,
    profile,
  };
}

export function downloadBackup(backup: Backup): void {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `overload-${backup.exportedAt.slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export interface ImportResult {
  exercises: number;
  templates: number;
  sessions: number;
  sets: number;
  weights: number;
}

/**
 * Replaces the local database with the file's contents.
 *
 * Replace, not merge. Merging two divergent histories needs a conflict rule
 * nobody has written, and a half-merged training log is worse than either
 * version of it. The caller confirms first.
 */
export async function importAll(raw: unknown): Promise<ImportResult> {
  const backup = Backup.parse(raw);
  await db.transaction(
    'rw',
    [db.exercises, db.templates, db.sessions, db.sets, db.weights, db.profile],
    async () => {
      await Promise.all([
        db.exercises.clear(),
        db.templates.clear(),
        db.sessions.clear(),
        db.sets.clear(),
        db.weights.clear(),
        db.profile.clear(),
      ]);
      await db.exercises.bulkAdd(backup.exercises);
      await db.templates.bulkAdd(backup.templates);
      await db.sessions.bulkAdd(backup.sessions);
      await db.sets.bulkAdd(backup.sets);
      await db.weights.bulkAdd(backup.weights);
      await db.profile.bulkAdd(backup.profile);
    },
  );
  return {
    exercises: backup.exercises.length,
    templates: backup.templates.length,
    sessions: backup.sessions.length,
    sets: backup.sets.length,
    weights: backup.weights.length,
  };
}
