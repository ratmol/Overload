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
import type { SyncMeta, SyncState, Tombstone } from './sync-bookkeeping.js';
import type {
  Adjustment,
  Exercise,
  FoodItem,
  FoodLogEntry,
  IntakeEntry,
  SavedMeal,
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
   * Sessions of accumulation before a scheduled deload, for a rolling program
   * with no fixed week. When set, this is what `detectDeload` uses instead of
   * `deloadEveryWeeks` — see rotation.ts and DECISIONS §24.
   */
  deloadEverySessions?: number;
  /**
   * Template ids in program order — Upper A, Lower A, Upper B, Lower B.
   * Dexie returns rows in primary-key order, which is alphabetical, and an
   * alphabetical week is not the week the plan prescribes.
   *
   * Doubles as the ROTATION order for a rolling program (`nextInRotation` in
   * rotation.ts): there is no separate field for it because this one already
   * is the sequence the plan defines, and a second field holding the same
   * list would just be a second place for it to drift out of sync.
   */
  templateOrder: string[];
  /** Kept as-is for Stage 3's volume audit. Not read in Stage 1. */
  volumeTargets: unknown;
  seededAt: string;
}

/**
 * The calorie target as it stands right now, plus the baseline it started from.
 *
 * The baseline is stored because `adjustTarget` needs it to detect cumulative
 * drift — the case where the engine has walked the target 300 kcal across
 * several cycles and the weight trend still has not responded, which is where
 * it stops adjusting and points at a blood panel instead.
 */
/**
 * A personal rearrangement of the day list on Today — not plan data.
 *
 * Kept separate from `PlanMeta.templateOrder`, which stays exactly what the
 * plan defines and drives the rotation recommendation. This is the opposite:
 * purely cosmetic, never read by `nextInRotation`, and never touched by a
 * plan migration (seed.ts writes `plan`, never `uiPrefs`) — rearranging your
 * own screen has nothing to do with which program version is loaded. Not
 * synced either (see sync-bookkeeping.ts's SYNCED_TABLES): it is a per-device
 * screen preference, the same category as `plan` and `templates` themselves.
 */
export interface UiPrefs {
  id: 'current';
  /**
   * Template ids in the order to display them, front to back. An id missing
   * from this list — never reordered yet, or a day a later plan version
   * added — is not dropped; see `orderedTemplateIds` in ui-prefs.ts.
   */
  templateOrder: string[];
}

export interface TargetState {
  id: 'current';
  currentKcal: number;
  baselineKcal: number;
  /** Set when the user accepts a proposal. Drives the 14-day cooldown. */
  lastAdjustmentDate: string | null;
  /**
   * Adjustments in a row that pushed the same way without the trend moving.
   * Incremented when a proposal is accepted in the same direction as the last
   * one and the observed rate has not come back inside the band.
   */
  consecutiveUnresponsive: number;
}

export class OverloadDb extends Dexie {
  exercises!: Table<Exercise, string>;
  templates!: Table<SessionTemplate, string>;
  sessions!: Table<Session, string>;
  sets!: Table<SetLog, string>;
  weights!: Table<WeightEntry, string>;
  profile!: Table<UserProfile, string>;
  plan!: Table<PlanMeta, string>;
  intake!: Table<IntakeEntry, string>;
  adjustments!: Table<Adjustment, string>;
  target!: Table<TargetState, string>;
  /** Sync bookkeeping. Owned by sync-bookkeeping.ts; nothing else reads these. */
  syncMeta!: Table<SyncMeta, string>;
  tombstones!: Table<Tombstone, string>;
  syncState!: Table<SyncState, string>;
  foods!: Table<FoodItem, string>;
  uiPrefs!: Table<UiPrefs, string>;
  /**
   * One row per food eaten, many per day, written incrementally.
   *
   * Deliberately NOT the same table as `intake`, which means one row per day or
   * per imported line and whose manual-entry path deletes every row for a date
   * before inserting. Sharing a table would mean logging breakfast and later
   * opening manual entry silently destroys breakfast. The two are reconciled by
   * `reconcileIntake` at read time.
   */
  foodLog!: Table<FoodLogEntry, string>;
  savedMeals!: Table<SavedMeal, string>;

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

    // v2 adds the calorie side. Purely additive — no existing table changes
    // shape, so v1 data upgrades with no migration function.
    this.version(2).stores({
      // `&date` is NOT unique here, unlike weights: MacroFactor exports one row
      // per day but Cronometer exports one row per food, and collapsing those
      // at import would throw away the detail. estimateTdee aggregates to daily
      // totals itself, precisely because multiple rows per day are legal.
      intake: 'id, date, activityTag',
      adjustments: 'id, date',
      target: 'id',
    });

    // v3 adds food logging. Additive again.
    //
    // The spec proposed `foods: 'id, name, barcode, isFavourite, lastUsedAt'`.
    // `isFavourite` is dropped from the index here: IndexedDB keys may only be
    // numbers, strings, Dates, ArrayBuffers or Arrays, so indexing a BOOLEAN
    // silently indexes nothing — `where('isFavourite').equals(true)` would
    // return an empty set forever, and nothing would report an error. It is a
    // personal list of a few dozen staples, so favourites and recency are
    // sorted in memory where the behaviour is visible.
    //
    // `[date+meal]` is a compound index over an optional field, so rows with no
    // meal are absent from it. Correct for "show me breakfast", wrong for "show
    // me the day" — that uses the plain `date` index.
    this.version(3).stores({
      foods: 'id, name, barcode, lastUsedAt',
      foodLog: 'id, date, foodId, [date+meal]',
      savedMeals: 'id',
    });

    // v4 adds sync bookkeeping. Additive, and deliberately in its own tables
    // rather than as columns on the domain rows: `packages/engine` owns those
    // shapes, and nothing that reads training data should have to learn what a
    // tombstone is.
    //
    // `dirty` is indexed as 1/0 rather than a boolean because IndexedDB keys
    // may not be booleans — indexing one silently indexes nothing, which is the
    // same trap that took out `foods.isFavourite` in v3.
    this.version(4).stores({
      syncMeta: 'id, table, dirty, updatedAt',
      tombstones: 'id, table, dirty, deletedAt',
      syncState: 'id',
    });

    // v5 adds the Today display-order preference. Additive, one row, never
    // synced — see UiPrefs' own comment for why this is not app data.
    this.version(5).stores({
      uiPrefs: 'id',
    });
  }
}

export const db = new OverloadDb();

/** Crypto-random id. Local-only, so collision resistance is all that matters. */
export function newId(): string {
  return crypto.randomUUID();
}
