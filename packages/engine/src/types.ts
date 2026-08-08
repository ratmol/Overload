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
  /** Signed. Positive = intended gain, negative = intended loss. */
  targetRatePerWeekLb: z.number(),
  /**
   * kcal per lb of bodyweight change. Overrides the phase default.
   * See docs/ALGORITHM.md — this is NOT 3500.
   */
  energyDensityOverride: z.number().positive().optional(),
  /** When true, adjust() must never move the target. */
  caloriesLocked: z.boolean().default(false),
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
  'lats',
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
  notes: z.string().optional(),
});
export type Exercise = z.infer<typeof Exercise>;

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
