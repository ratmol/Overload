/**
 * JSON export and import.
 *
 * This is the whole answer to "what if I lose the phone". There is no server,
 * so the export file IS the backup, and an import that does not round-trip
 * exactly is data loss with extra steps. Every row is validated against the
 * engine's Zod schemas on the way back in — the same schemas that guard the
 * engine — so a hand-edited or truncated file is rejected whole rather than
 * applied halfway.
 *
 * Format 2 added the calorie tables. Format 1 files still import: an old
 * backup is exactly the situation a backup exists for, and refusing to read one
 * because the app moved on would defeat the point.
 */
import { z } from 'zod';
import {
  Adjustment,
  Exercise,
  IntakeEntry,
  Session,
  SessionTemplate,
  SetLog,
  UserProfile,
  WeightEntry,
} from '@overload/engine';
import { db } from './db.js';

export const BACKUP_FORMAT = 2;

const TargetStateSchema = z.object({
  id: z.literal('current'),
  currentKcal: z.number().positive(),
  baselineKcal: z.number().positive(),
  lastAdjustmentDate: z.string().nullable(),
  consecutiveUnresponsive: z.number().int().nonnegative(),
});

/** Everything present in format 1. */
const TrainingTables = z.object({
  app: z.literal('overload'),
  exportedAt: z.string(),
  exercises: z.array(Exercise),
  templates: z.array(SessionTemplate),
  sessions: z.array(Session),
  sets: z.array(SetLog),
  weights: z.array(WeightEntry),
  profile: z.array(UserProfile),
});

const BackupV1 = TrainingTables.extend({ format: z.literal(1) });

const BackupV2 = TrainingTables.extend({
  format: z.literal(2),
  intake: z.array(IntakeEntry),
  adjustments: z.array(Adjustment),
  target: z.array(TargetStateSchema),
});

const AnyBackup = z.union([BackupV2, BackupV1]);

export type Backup = z.infer<typeof BackupV2>;

/** Fills in the tables a format 1 file predates. */
function upgrade(raw: z.infer<typeof AnyBackup>): Backup {
  if (raw.format === 2) return raw;
  return { ...raw, format: 2, intake: [], adjustments: [], target: [] };
}

export async function exportAll(): Promise<Backup> {
  const [exercises, templates, sessions, sets, weights, profile, intake, adjustments, target] =
    await Promise.all([
      db.exercises.toArray(),
      db.templates.toArray(),
      db.sessions.toArray(),
      db.sets.toArray(),
      db.weights.toArray(),
      db.profile.toArray(),
      db.intake.toArray(),
      db.adjustments.toArray(),
      db.target.toArray(),
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
    intake,
    adjustments,
    target,
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
  format: number;
  exercises: number;
  templates: number;
  sessions: number;
  sets: number;
  weights: number;
  intake: number;
  adjustments: number;
}

/**
 * Replaces the local database with the file's contents.
 *
 * Replace, not merge. Merging two divergent histories needs a conflict rule
 * nobody has written, and a half-merged training log is worse than either
 * version of it. The caller confirms first.
 */
export async function importAll(raw: unknown): Promise<ImportResult> {
  const parsed = AnyBackup.parse(raw);
  const backup = upgrade(parsed);

  await db.transaction(
    'rw',
    [
      db.exercises,
      db.templates,
      db.sessions,
      db.sets,
      db.weights,
      db.profile,
      db.intake,
      db.adjustments,
      db.target,
    ],
    async () => {
      await Promise.all([
        db.exercises.clear(),
        db.templates.clear(),
        db.sessions.clear(),
        db.sets.clear(),
        db.weights.clear(),
        db.profile.clear(),
        db.intake.clear(),
        db.adjustments.clear(),
        db.target.clear(),
      ]);
      await db.exercises.bulkAdd(backup.exercises);
      await db.templates.bulkAdd(backup.templates);
      await db.sessions.bulkAdd(backup.sessions);
      await db.sets.bulkAdd(backup.sets);
      await db.weights.bulkAdd(backup.weights);
      await db.profile.bulkAdd(backup.profile);
      await db.intake.bulkAdd(backup.intake);
      await db.adjustments.bulkAdd(backup.adjustments);
      await db.target.bulkAdd(backup.target);
    },
  );

  return {
    format: parsed.format,
    exercises: backup.exercises.length,
    templates: backup.templates.length,
    sessions: backup.sessions.length,
    sets: backup.sets.length,
    weights: backup.weights.length,
    intake: backup.intake.length,
    adjustments: backup.adjustments.length,
  };
}
