/**
 * IndexedDB via Dexie. Tables mirror the Zod schemas in @overload/engine
 * one-for-one — no app-local shapes, no denormalised copies.
 *
 * Two rules carried over from the engine:
 *  - Nothing derived is stored. No systemLoad column, no weekly totals, no
 *    session summaries. Everything derived is computed at read time.
 *  - Dates are ISO calendar strings, so they index and range-query in
 *    lexicographic order, which is also chronological order.
 *
 * Index choices are recorded in docs/DECISIONS.md §14.
 */
import Dexie, { type Table } from 'dexie';
import type {
  Exercise,
  Session,
  SessionTemplate,
  SetLog,
  UserProfile,
  WeightEntry,
} from '@overload/engine';

/**
 * The training program, stored rather than read from plan.json at runtime, so
 * that editing a rep range in the app does not get silently reverted by the
 * next deploy. plan.json seeds it once; after that the database is the truth.
 */
export interface PlanMeta {
  id: 'current';
  version: number;
  name: string;
  deloadEveryWeeks: number;
  /**
   * Template ids in program order — Upper A, Lower A, Upper B, Lower B.
   * Dexie returns rows in primary-key order, which is alphabetical, and an
   * alphabetical week is not the week the plan prescribes.
   */
  templateOrder: string[];
  /** Kept as-is for Stage 3's volume audit. Not read in Stage 1. */
  volumeTargets: unknown;
  seededAt: string;
}

export class OverloadDb extends Dexie {
  exercises!: Table<Exercise, string>;
  templates!: Table<SessionTemplate, string>;
  sessions!: Table<Session, string>;
  sets!: Table<SetLog, string>;
  weights!: Table<WeightEntry, string>;
  profile!: Table<UserProfile, string>;
  plan!: Table<PlanMeta, string>;

  constructor() {
    super('overload');
    this.version(1).stores({
      exercises: 'id, name',
      templates: 'id',
      // `date` sorts sessions chronologically; `[templateId+date]` answers
      // "when did I last do Upper A" without a table scan.
      sessions: 'id, date, templateId, [templateId+date]',
      // `[exerciseId+sessionId]` is the hot path: the session screen asks for
      // one exercise's sets in one session on every keystroke.
      sets: 'id, sessionId, exerciseId, [exerciseId+sessionId], [sessionId+exerciseId]',
      // `&date` is unique: one weigh-in per calendar day. A second entry for the
      // same day replaces the first rather than quietly skewing the trend.
      weights: 'id, &date',
      profile: 'id',
      plan: 'id',
    });
  }
}

export const db = new OverloadDb();

/** Crypto-random id. Local-only, so collision resistance is all that matters. */
export function newId(): string {
  return crypto.randomUUID();
}
