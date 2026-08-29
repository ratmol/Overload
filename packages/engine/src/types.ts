/**
 * Single source of truth for every persisted shape in overload.
 *
 * Rules:
 *  - Nothing derived is stored. systemLoad, daily totals, weekly volume and
 *    trend values are all computed at read time. See docs/DECISIONS.md.
 *  - Dates are ISO calendar dates (YYYY-MM-DD), never timestamps, because
 *    every domain rule here is day-grained. Timestamps only appear on SetLog
 *    where within-session ordering matters.
 *  - Mass is stored in pounds. unitPreference is a display concern only.
 */
import { z } from 'zod';

/** ISO calendar date, YYYY-MM-DD. */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export type IsoDate = z.infer<typeof IsoDate>;

export const Id = z.string().min(1);

export const ActivityTag = z.enum(['shift', 'off']);
export type ActivityTag = z.infer<typeof ActivityTag>;

export const GoalType = z.enum(['gain', 'maintain', 'loss']);
export type GoalType = z.infer<typeof GoalType>;

export const Confidence = z.enum(['low', 'medium', 'high']);
export type Confidence = z.infer<typeof Confidence>;

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export const UserProfile = z.object({
  id: Id,
  heightCm: z.number().positive(),
  birthYear: z.number().int().min(1900),
  unitPreference: z.enum(['imperial', 'metric']),
  goalType: GoalType,
  /**
   * Acceptable rate band, lb/week, signed. Positive = gain.
   * A BAND, not a point: the plan says 0.25-0.5 lb/week, and an engine that
   * chases a scalar will adjust every single week because the observed rate is
   * essentially never exactly equal to one number. Inside the band, do nothing.
   */
  targetRateBandLbPerWeek: z
    .tuple([z.number(), z.number()])
    .refine(([lo, hi]) => lo <= hi, 'rate band lo must be <= hi')
    .refine(([lo, hi]) => Math.abs(lo) <= 3 && Math.abs(hi) <= 3, 'rate band is implausible'),
  /**
   * kcal per lb of bodyweight change. Overrides the phase default.
   * Bounded: below ~800 is less than lean tissue, above ~4300 is more than
   * pure lipid. Anything outside that is a typo, not a preference.
   */
  energyDensityOverride: z.number().min(800).max(4300).optional(),
  /** When true, adjust() must never move the target. */
  caloriesLocked: z.boolean().default(false),
  /**
   * Absolute floor for the calorie target. Defaults are applied in adjust.ts.
   * Exists because nothing else in the system stops a downward ratchet.
   */
  minTargetKcal: z.number().positive().optional(),
  /**
   * Date the baseline bloodwork was done (iron/ferritin, B12, D, TSH, celiac).
   * Null means not done. The engine surfaces this rather than silently
   * assuming every flat trend is a calorie problem.
   */
  medicalScreenCompletedDate: IsoDate.nullable().default(null),
});
export type UserProfile = z.infer<typeof UserProfile>;

// ---------------------------------------------------------------------------
// Body data
// ---------------------------------------------------------------------------

export const WeightEntry = z.object({
  id: Id,
  date: IsoDate,
  weightLb: z.number().positive(),
  source: z.enum(['manual', 'import']),
  /** Set by trend analysis, not by the user. Never causes deletion. */
  flaggedOutlier: z.boolean().default(false),
  note: z.string().optional(),
});
export type WeightEntry = z.infer<typeof WeightEntry>;

export const IntakeEntry = z.object({
  id: Id,
  date: IsoDate,
  calories: z.number().nonnegative(),
  proteinG: z.number().nonnegative(),
  carbsG: z.number().nonnegative(),
  fatG: z.number().nonnegative(),
  source: z.enum(['manual', 'import']),
  activityTag: ActivityTag,
});
export type IntakeEntry = z.infer<typeof IntakeEntry>;

export const ScanRecord = z.object({
  id: Id,
  date: IsoDate,
  bodyFatPct: z.number().min(0).max(100),
  ffmLb: z.number().positive(),
  /** Appendicular Lean Mass Index, kg/m². The actual goal metric. */
  almi: z.number().positive(),
  vatG: z.number().nonnegative(),
  bmd: z.number().positive(),
  source: z.string(),
  /** Facility + scanner, so cross-machine comparisons can be flagged. */
  facility: z.string().optional(),
});
export type ScanRecord = z.infer<typeof ScanRecord>;

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

export const MuscleGroup = z.enum([
  'chest',
  'upperChest',
  /** Total lat volume, including heavy vertical pulling. */
  'lats',
  /**
   * Width-biased lat work specifically: wide grips, higher reps, loaded
   * stretch. Tracked SEPARATELY from `lats` because heavy weighted pull-ups
   * are an excellent thickness stimulus and a mediocre width one. Without this
   * split, swapping both pulldown slots for heavy rows leaves total lat volume
   * looking healthy while width work goes to zero — the exact mistake the
   * training plan was written to correct.
   */
  'latsWidth',
  'upperBack',
  'lowerBack',
  'frontDelts',
  'sideDelts',
  'rearDelts',
  'lowerTraps',
  'biceps',
  'triceps',
  'forearms',
  'quads',
  'hamstrings',
  'glutes',
  'calves',
  'abs',
  /** Direct neck work (neck curls). Added for the 1x4 Method's accessory day. */
  'neck',
]);
export type MuscleGroup = z.infer<typeof MuscleGroup>;

/** How much a set counts toward a muscle's weekly volume. */
export const MuscleContribution = z.object({
  muscle: MuscleGroup,
  /** 1 = direct/primary, 0.5 = meaningful secondary. Never below 0.25. */
  fraction: z.number().min(0.25).max(1),
});
export type MuscleContribution = z.infer<typeof MuscleContribution>;

export const RepRange = z
  .tuple([z.number().int().positive(), z.number().int().positive()])
  .refine(([min, max]) => min <= max, 'repRange min must be <= max');
export type RepRange = z.infer<typeof RepRange>;

export const Exercise = z.object({
  id: Id,
  name: z.string().min(1),
  muscles: z.array(MuscleContribution).min(1),
  /**
   * True for pull-ups, dips, and anything where bodyweight is part of the
   * load. Drives systemLoad. This is the headline feature.
   */
  isBodyweightLoaded: z.boolean(),
  /** Smallest load step for double progression. 2.5 on bodyweight-loaded. */
  incrementLb: z.number().positive(),
  defaultRepRange: RepRange,
  defaultSets: z.number().int().positive(),
  /** Seeded from the plan. Not authoritative once real sets exist. */
  startingLoadLb: z.number().nonnegative().optional(),
  /**
   * Strict bodyweight reps required before any load may be added.
   * From the plan: 10 on pull-ups, 12 on dips. The one hard safety rule in the
   * loading section. Also applies coming out of a deload, where the belt is
   * stripped back to bodyweight.
   */
  entryStandardReps: z.number().int().positive().optional(),
  /**
   * Per-set RIR targets, in order. `[2, 2, 1]` means the last set is the only
   * hard one; `[0, 0, 0, 0]` means true failure every set.
   *
   * This is the core of program v2 and it is per-SET, not per-exercise, because
   * the whole redesign is "failure is earned by the exercise, not by me": a
   * cable lateral raise fails locally and costs a sore delt, while a +70 dip
   * fails systemically and costs the next 48 hours. A single RIR field per
   * exercise cannot express a ladder, and without the ladder the app prescribes
   * the sets while losing the reason they are survivable.
   *
   * Shorter than `defaultSets` is legal — the last value repeats.
   */
  targetRirBySet: z.array(z.number().min(0).max(10)).optional(),
  /**
   * Exercises sharing a group are supersetted and alternated. Antagonist
   * pairing is what makes a 19-set session fit in 34 minutes: each exercise
   * fills the other's rest with no interference.
   */
  supersetGroup: z.string().optional(),
  /** Rest after a set of this exercise, seconds. Overrides the global default. */
  restSeconds: z.number().int().positive().optional(),
  /**
   * Exercises that can stand in for this one, best first.
   *
   * Exists because the two commonest reasons a session goes badly are "the rack
   * is taken" and "I do not fancy this today", and the honest answer to both is
   * a different exercise rather than a skipped slot. Alternates keep their own
   * load history, so swapping back later resumes where that lift left off.
   */
  alternates: z.array(Id).optional(),
  notes: z.string().optional(),
  /**
   * True for an exercise the user added themselves, as opposed to one seeded
   * from `data/plan.json`. Exists so the app can tell the two apart — a
   * custom row is never touched by a plan migration (§18 only overwrites ids
   * plan.json defines) and is never at risk of being renamed out from under
   * the person who created it.
   */
  custom: z.boolean().optional(),
});
export type Exercise = z.infer<typeof Exercise>;

/**
 * Rest to use when a superset is run as straight sets instead.
 *
 * In a superset the rest between two sets of the SAME exercise is the
 * prescribed gap, plus the partner's working set, plus the gap again — roughly
 * `2 x restSeconds` once the partner's set is counted. Running straight sets at
 * the superset's own 90s would therefore be a real cut in rest, not a neutral
 * change, and would make the session harder while claiming to make it easier.
 *
 * Approximate on purpose. It is capped at five minutes because past that the
 * session stops fitting in the time it was designed around.
 */
export function straightSetRestSeconds(restSeconds: number): number {
  return Math.min(300, restSeconds * 2);
}

/**
 * The RIR target for one set, zero-indexed.
 *
 * The last entry repeats when the ladder is shorter than the set count, so
 * `[2, 2, 1]` on a fourth set gives 1 rather than undefined. Falls back to the
 * supplied default when the exercise has no ladder at all, which is every
 * exercise seeded from plan v1.
 */
export function targetRirForSet(
  exercise: Pick<Exercise, 'targetRirBySet'>,
  setIndex: number,
  fallback = 2,
): number {
  const ladder = exercise.targetRirBySet;
  if (!ladder || ladder.length === 0) return fallback;
  return ladder[Math.min(setIndex, ladder.length - 1)] ?? fallback;
}

export const SessionTemplate = z.object({
  id: Id,
  name: z.string().min(1),
  exerciseIds: z.array(Id).min(1),
});
export type SessionTemplate = z.infer<typeof SessionTemplate>;

export const Session = z.object({
  id: Id,
  date: IsoDate,
  templateId: Id,
  isDeload: z.boolean().default(false),
  /** 1-5, user-reported. Feeds deload triggers. */
  sleepQuality: z.number().int().min(1).max(5).optional(),
  jointPainFlag: z.boolean().optional(),
  /**
   * Morning resting heart rate, bpm. The plan's most valuable deload trigger:
   * objective, auto-collectable from any wearable, and the only signal in the
   * list that fires before performance visibly drops.
   */
  restingHeartRateBpm: z.number().int().min(20).max(200).optional(),
  /**
   * Genuine dread about training, as opposed to ordinary reluctance. One tap,
   * and in practice the trigger people actually act on.
   */
  dreadFlag: z.boolean().optional(),
  /**
   * Exercises swapped for this session only, keyed by the id they replace.
   * The template is untouched — next week goes back to the programmed lift.
   */
  swaps: z.record(Id, Id).optional(),
  /**
   * Programmed slot ids dropped from THIS session — running low on time or
   * too tired for everything on the sheet. Keyed the same way as `swaps`
   * (the slot id, i.e. the exercise the template originally names), so a
   * slot cannot be both swapped and skipped without one silently winning;
   * the app checks skips first. The template itself is untouched: next
   * session the slot is back, same as a swap reverting on its own.
   */
  skips: z.array(Id).optional(),
  /**
   * Run the session as straight sets.
   *
   * A superset needs two stations held at once, which is exactly what a busy
   * gym will not allow. Rather than silently doing the wrong thing, the session
   * says it is running straight and lengthens the rest to match — see
   * `straightSetRestSeconds`.
   */
  supersetsOff: z.boolean().optional(),
  /**
   * Wall-clock instant the user tapped "Finish session". Stored so the
   * gym-time total survives into history; the START is never stored — it is
   * derived from the first working set (see `firstWorkingSetAt`), which keeps
   * to the rule that nothing derived is persisted. Absent means the session
   * was never formally finished (walked out, or still open).
   */
  finishedAt: z.string().datetime().optional(),
});
export type Session = z.infer<typeof Session>;

export const SetLog = z.object({
  id: Id,
  sessionId: Id,
  exerciseId: Id,
  /**
   * For bodyweight-loaded exercises this is the BELT weight only.
   * For everything else it is the full external load.
   * systemLoad is derived, never stored. See systemLoad() in progression.ts.
   */
  addedWeightLb: z.number(),
  reps: z.number().int().nonnegative(),
  /** Reps in reserve. 0 = to failure. */
  rir: z.number().min(0).max(10),
  timestamp: z.string().datetime(),
  isWarmup: z.boolean().default(false),
});
export type SetLog = z.infer<typeof SetLog>;

// ---------------------------------------------------------------------------
// Food
// ---------------------------------------------------------------------------

export const Meal = z.enum(['meal1', 'meal2', 'snack', 'meal3', 'prebed']);
export type Meal = z.infer<typeof Meal>;

export const Macros = z.object({
  kcal: z.number().nonnegative(),
  proteinG: z.number().nonnegative(),
  carbsG: z.number().nonnegative(),
  fatG: z.number().nonnegative(),
  fiberG: z.number().nonnegative().optional(),
});
export type Macros = z.infer<typeof Macros>;

/** A named amount of a food: "1 breast" = 174 g, "1 scoop" = 31 g. */
export const Portion = z.object({
  label: z.string().min(1),
  grams: z.number().positive(),
});
export type Portion = z.infer<typeof Portion>;

export const FoodItem = z.object({
  id: Id,
  /**
   * Cooked vs raw belongs IN THE NAME, always. 100 g of raw chicken and 100 g
   * of cooked chicken differ by roughly 30% in calories, USDA lists both under
   * near-identical names, and picking the wrong one is a silent 200 kcal/day
   * error that looks exactly like a metabolism.
   */
  name: z.string().min(1),
  brand: z.string().optional(),
  barcode: z.string().optional(),
  /**
   * Per 100 g, always. One canonical basis makes portion arithmetic a single
   * multiplication instead of a unit-conversion layer, and Open Food Facts
   * returns per-serving figures inconsistently enough that storing them would
   * mean storing which basis each row used.
   */
  per100g: Macros,
  portions: z.array(Portion).default([]),
  source: z.enum(['usda', 'openfoodfacts', 'manual']),
  /** FDC id or barcode, so a suspect entry can be re-checked at the source. */
  sourceId: z.string().optional(),
  isFavourite: z.boolean().default(false),
  lastUsedAt: z.string().datetime().optional(),
});
export type FoodItem = z.infer<typeof FoodItem>;

/**
 * One food eaten. Many per day.
 *
 * The macros are a SNAPSHOT taken at log time, which is a deliberate exception
 * to "nothing derived is stored" — see docs/DECISIONS.md §16. Correcting a
 * food's macros later must not rewrite months of logged days, because those
 * days already fed calorie decisions the engine made and explained. History is
 * a record of what was believed at the time.
 */
export const FoodLogEntry = z.object({
  id: Id,
  date: IsoDate,
  foodId: Id,
  grams: z.number().positive(),
  kcal: z.number().nonnegative(),
  proteinG: z.number().nonnegative(),
  carbsG: z.number().nonnegative(),
  fatG: z.number().nonnegative(),
  meal: Meal.optional(),
  loggedAt: z.string().datetime(),
});
export type FoodLogEntry = z.infer<typeof FoodLogEntry>;

export const SavedMeal = z.object({
  id: Id,
  name: z.string().min(1),
  items: z.array(z.object({ foodId: Id, grams: z.number().positive() })).min(1),
});
export type SavedMeal = z.infer<typeof SavedMeal>;

// ---------------------------------------------------------------------------
// Plan (data/plan.json)
// ---------------------------------------------------------------------------

export const VolumeTarget = z.object({
  muscle: MuscleGroup,
  minSetsPerWeek: z.number().nonnegative(),
  maxSetsPerWeek: z.number().nonnegative(),
  priority: z.number().int().min(1).max(5).optional(),
});
export type VolumeTarget = z.infer<typeof VolumeTarget>;

export const Plan = z.object({
  version: z.number().int().positive(),
  name: z.string(),
  exercises: z.array(Exercise),
  templates: z.array(SessionTemplate),
  volumeTargets: z.array(VolumeTarget),
  /** Weeks of accumulation before a scheduled deload. */
  deloadEveryWeeks: z.number().int().positive(),
  /**
   * Sessions of accumulation before a scheduled deload, for a rolling program
   * that is not tied to the calendar (see `rotation.ts`). When present,
   * `detectDeload` prefers this over `deloadEveryWeeks` — a program built
   * around "the next session", not "Monday", should not have its recovery
   * timer run on a clock the program itself ignores.
   */
  deloadEverySessions: z.number().int().positive().optional(),
});
export type Plan = z.infer<typeof Plan>;

// ---------------------------------------------------------------------------
// Engine outputs (computed, but validated so the UI boundary is typed)
// ---------------------------------------------------------------------------

export const Adjustment = z.object({
  id: Id,
  date: IsoDate,
  previousTarget: z.number().positive(),
  newTarget: z.number().positive(),
  /**
   * Human-readable. If this cannot be generated, the adjustment must not
   * happen. This field is the product philosophy.
   */
  reason: z.string().min(1),
  confidence: Confidence,
});
export type Adjustment = z.infer<typeof Adjustment>;
