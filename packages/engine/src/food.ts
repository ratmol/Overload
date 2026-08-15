/**
 * Portion arithmetic and the seam between food rows and the calorie engine.
 *
 * Pure. No network — the APIs that fetch foods live in `apps/web`, because a
 * function that both fetches and calculates is two functions.
 *
 * The important export is `reconcileIntake`. Everything downstream of it —
 * `estimateTdee`, `adjustTarget`, the dashboard — keeps seeing exactly the
 * `IntakeEntry[]` it has always seen, so adding food logging changes no
 * calorie code at all.
 */
import type {
  ActivityTag,
  FoodItem,
  FoodLogEntry,
  IntakeEntry,
  IsoDate,
  Macros,
} from './types.js';

/**
 * Macros for an arbitrary weight of a food.
 *
 * Trivial, and tested anyway, because it is the function every screen calls and
 * a factor-of-100 error here is invisible in any single number while being
 * catastrophic in the aggregate.
 */
export function macrosForGrams(
  food: Pick<FoodItem, 'per100g'>,
  grams: number,
): Macros {
  if (!Number.isFinite(grams) || grams < 0) {
    throw new RangeError(`grams must be a non-negative number (got ${grams})`);
  }
  const k = grams / 100;
  const p = food.per100g;
  return {
    kcal: p.kcal * k,
    proteinG: p.proteinG * k,
    carbsG: p.carbsG * k,
    fatG: p.fatG * k,
    ...(p.fiberG === undefined ? {} : { fiberG: p.fiberG * k }),
  };
}

export interface PortionRequest {
  /** Must match a label in the food's `portions`. */
  portionLabel?: string;
  /** An explicit weight. Wins over a named portion when both are given. */
  grams?: number;
  /** Multiplier on a named portion. Defaults to 1. */
  count?: number;
}

/**
 * Resolves a portion request to grams, or null when it cannot be resolved.
 *
 * Null rather than a fallback: a food's portion list can change, and the only
 * alternatives to null are guessing 100 g or throwing. Guessing writes a wrong
 * meal into a log that feeds calorie decisions, and it looks entirely plausible
 * afterwards. The UI shows an error instead.
 */
export function resolvePortion(
  food: Pick<FoodItem, 'portions'>,
  request: PortionRequest,
): number | null {
  if (request.grams !== undefined) {
    return Number.isFinite(request.grams) && request.grams > 0 ? request.grams : null;
  }
  if (request.portionLabel === undefined) return null;

  const portion = food.portions.find((p) => p.label === request.portionLabel);
  if (!portion) return null;

  const count = request.count ?? 1;
  if (!Number.isFinite(count) || count <= 0) return null;
  return portion.grams * count;
}

export function sumFoodLog(entries: readonly FoodLogEntry[]): {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
} {
  return entries.reduce(
    (acc, e) => ({
      kcal: acc.kcal + e.kcal,
      proteinG: acc.proteinG + e.proteinG,
      carbsG: acc.carbsG + e.carbsG,
      fatG: acc.fatG + e.fatG,
    }),
    { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 },
  );
}

/**
 * Collapses one day of food rows into the single `IntakeEntry` the calorie
 * engine already understands.
 *
 * The id is derived from the date rather than generated, because this value is
 * computed at read time and never stored. A random id would make the same day
 * look like a different row on every render.
 */
export function toIntakeEntry(
  date: IsoDate,
  entries: readonly FoodLogEntry[],
  activityTag: ActivityTag,
): IntakeEntry {
  const total = sumFoodLog(entries);
  return {
    id: `food:${date}`,
    date,
    calories: total.kcal,
    proteinG: total.proteinG,
    carbsG: total.carbsG,
    fatG: total.fatG,
    source: 'manual',
    activityTag,
  };
}

export interface ReconcileResult {
  /** Feed this to `estimateTdee`. Never both tables concatenated. */
  entries: IntakeEntry[];
  /**
   * Food-derived days whose activity tag had to be assumed.
   *
   * Callers must exclude these before calling `summariseTaggedIntake` — an
   * assumed tag is fine for a calorie total, which ignores the tag entirely,
   * and is not fine for a comparison whose entire subject is the tag.
   */
  untaggedDates: IsoDate[];
}

/**
 * The reconciliation rule. Food rows win where they exist.
 *
 * Two tables exist because they mean different things: `foodLog` is one row per
 * food, written incrementally through the day, and `intake` is one row per day
 * or per imported line. Handing both to the estimator concatenated would
 * double-count every day recorded in both, which moves estimated expenditure by
 * roughly the size of a day's eating.
 *
 * Food logging wins because it is the more specific record: if you logged
 * individual foods for a day, that is a better account of it than an imported
 * daily total from an app you were also using.
 */
export function reconcileIntake(
  intake: readonly IntakeEntry[],
  foodLog: readonly FoodLogEntry[],
  options: {
    /** The activity tag for a date, when it is known. */
    tagFor?: (date: IsoDate) => ActivityTag | undefined;
    /** Used only for days where `tagFor` gives nothing. */
    assumedTag?: ActivityTag;
  } = {},
): ReconcileResult {
  const assumed = options.assumedTag ?? 'off';

  const byDate = new Map<IsoDate, FoodLogEntry[]>();
  for (const entry of foodLog) {
    const list = byDate.get(entry.date);
    if (list) list.push(entry);
    else byDate.set(entry.date, [entry]);
  }

  const untaggedDates: IsoDate[] = [];
  const entries: IntakeEntry[] = [];

  for (const [date, rows] of byDate) {
    // An existing intake row for the same day is the best available source of
    // the tag, even though its calories are about to be superseded.
    const known = options.tagFor?.(date) ?? intake.find((e) => e.date === date)?.activityTag;
    if (known === undefined) untaggedDates.push(date);
    entries.push(toIntakeEntry(date, rows, known ?? assumed));
  }

  for (const entry of intake) {
    if (byDate.has(entry.date)) continue;
    entries.push(entry);
  }

  entries.sort((a, b) => a.date.localeCompare(b.date));
  untaggedDates.sort();
  return { entries, untaggedDates };
}

/** kcal per gram, Atwater. Used only to sanity-check a THIRD-PARTY total. */
const KCAL_PER_G_PROTEIN = 4;
const KCAL_PER_G_CARB = 4;
const KCAL_PER_G_FAT = 9;

export interface EnergyCheck {
  /** kcal implied by 4/4/9 on the given macros. */
  impliedKcal: number;
  /** Signed: positive means the stated kcal is higher than the macros imply. */
  differenceKcal: number;
  /** |difference| as a fraction of the implied kcal. */
  differenceFraction: number;
  reconciles: boolean;
}

/**
 * Does a food's stated calorie count roughly match 4/4/9 on its macros?
 *
 * This exists for exactly one caller: a barcode lookup against a crowd-sourced
 * database. Open Food Facts entries are user-submitted and "missing or absurd
 * macros are common" — see docs/FOOD-LOGGING-SPEC.md §5.2. A product reporting
 * 40 kcal per 100g and 20g of fat per 100g is not a food, it is a typo, and
 * saving it verbatim writes a wrong number into every day it gets logged on.
 *
 * Manually entered foods are NOT run through this. A user weighing their own
 * cooked chicken and typing the label's numbers is the ground truth this
 * project trusts; this check exists to catch a THIRD PARTY's data entry error,
 * not to second-guess the person doing the logging.
 *
 * 20% by default, not tighter: fibre is sometimes excluded from the Atwater sum
 * on a label, alcohol (7 kcal/g) is not represented here at all, and rounding
 * on small package sizes compounds fast. The job is to catch "this row is
 * garbage", not to audit legitimate labelling variance.
 */
export function energyReconciles(macros: Macros, toleranceFraction = 0.2): EnergyCheck {
  const impliedKcal =
    macros.proteinG * KCAL_PER_G_PROTEIN +
    macros.carbsG * KCAL_PER_G_CARB +
    macros.fatG * KCAL_PER_G_FAT;

  const differenceKcal = macros.kcal - impliedKcal;

  // A near-zero-calorie food (water, black coffee) makes any fractional
  // comparison meaningless — 2 kcal implied vs 0 kcal stated is a 100%
  // "difference" that is not evidence of anything. Below 20 kcal implied,
  // pass on the absolute gap instead.
  if (impliedKcal < 20) {
    return {
      impliedKcal,
      differenceKcal,
      differenceFraction: 0,
      reconciles: Math.abs(differenceKcal) <= 20,
    };
  }

  const differenceFraction = Math.abs(differenceKcal) / impliedKcal;
  return {
    impliedKcal,
    differenceKcal,
    differenceFraction,
    reconciles: differenceFraction <= toleranceFraction,
  };
}

export interface ProteinAdherence {
  proteinG: number;
  targetG: number;
  met: boolean;
  /** Grams short. Zero when the target was met. */
  shortfallG: number;
  reason: string;
}

/**
 * Did the day hit its protein target?
 *
 * `IntakeEntry.proteinG` has been stored since the schema was written and
 * nothing in the engine has ever read it. The training plan lists protein as a
 * non-negotiable and is explicit that missing calories is survivable while
 * chronically missing protein is not — at which point the whole surplus is
 * being spent on the wrong tissue. Ten lines against data already collected is
 * worth more than another refinement to the energy density constant.
 */
export function proteinAdherence(
  entries: readonly FoodLogEntry[],
  targetG: number,
): ProteinAdherence {
  const proteinG = sumFoodLog(entries).proteinG;
  const shortfall = Math.max(0, targetG - proteinG);
  const met = proteinG >= targetG;
  return {
    proteinG,
    targetG,
    met,
    shortfallG: shortfall,
    reason: met
      ? `${Math.round(proteinG)} g against a ${targetG} g target.`
      : `${Math.round(proteinG)} g against a ${targetG} g target — ${Math.round(shortfall)} g short. Calories can be missed occasionally; protein missed consistently spends the surplus on the wrong tissue.`,
  };
}
