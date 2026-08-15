/**
 * Reads and writes for the personal food list and the food log.
 *
 * `foods` is the list — a few dozen staples plus whatever a barcode scan adds.
 * `foodLog` is one row per food eaten, reconciled against `intake` at read time
 * by the engine's `reconcileIntake` (see db/nutrition.ts). Nothing here decides
 * calorie policy; it only stores what was logged.
 */
import { macrosForGrams, type FoodItem, type FoodLogEntry, type IsoDate, type Meal } from '@overload/engine';
import { db, newId } from './db.js';
import { touch, tombstone } from './sync-bookkeeping.js';

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/**
 * Favourites first, then most recently used, then alphabetical.
 *
 * Sorted in memory rather than by an IndexedDB index — `isFavourite` is a
 * boolean, and IndexedDB keys cannot be booleans, so indexing it would
 * silently index nothing (the same trap noted in DECISIONS §17 for this exact
 * field). A personal list of a few dozen items makes an in-memory sort free.
 */
export async function listFoods(): Promise<FoodItem[]> {
  const foods = await db.foods.toArray();
  return foods.sort((a, b) => {
    if (a.isFavourite !== b.isFavourite) return a.isFavourite ? -1 : 1;
    const byRecency = (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '');
    if (byRecency !== 0) return byRecency;
    return a.name.localeCompare(b.name);
  });
}

export async function getFoodByBarcode(barcode: string): Promise<FoodItem | undefined> {
  return db.foods.where('barcode').equals(barcode).first();
}

/** Adds a food to the list, from a manual form or an accepted barcode candidate. */
export async function addFood(food: Omit<FoodItem, 'id'>): Promise<string> {
  const id = newId();
  await db.foods.add({ ...food, id });
  await touch('foods', [id]);
  return id;
}

export async function updateFood(id: string, patch: Partial<Omit<FoodItem, 'id'>>): Promise<void> {
  await db.foods.update(id, patch);
  await touch('foods', [id]);
}

export async function toggleFavourite(id: string, isFavourite: boolean): Promise<void> {
  await db.foods.update(id, { isFavourite });
  await touch('foods', [id]);
}

/**
 * Deletes a food from the list.
 *
 * Past `foodLog` rows are untouched — they snapshot their macros at log time
 * (DECISIONS §17) precisely so a food can be edited or removed later without
 * rewriting history. The `foodId` on old rows becomes a dangling reference,
 * which is fine: nothing re-reads through it.
 */
export async function deleteFood(id: string): Promise<void> {
  await db.foods.delete(id);
  await tombstone('foods', [id]);
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

/**
 * Logs a portion of a food, snapshotting its macros now.
 *
 * The snapshot is the point: correcting a food's macros later must not
 * retroactively rewrite a day that already fed a calorie decision the engine
 * explained and the user accepted. See DECISIONS §17.
 */
export async function logFoodPortion(input: {
  food: FoodItem;
  grams: number;
  date: IsoDate;
  meal?: Meal;
}): Promise<string> {
  const macros = macrosForGrams(input.food, input.grams);
  const id = newId();
  const now = new Date().toISOString();

  const entry: FoodLogEntry = {
    id,
    date: input.date,
    foodId: input.food.id,
    grams: input.grams,
    kcal: macros.kcal,
    proteinG: macros.proteinG,
    carbsG: macros.carbsG,
    fatG: macros.fatG,
    ...(input.meal ? { meal: input.meal } : {}),
    loggedAt: now,
  };

  await db.transaction('rw', db.foodLog, db.foods, async () => {
    await db.foodLog.add(entry);
    // lastUsedAt drives the "recent" half of the list ordering above.
    await db.foods.update(input.food.id, { lastUsedAt: now });
  });

  await touch('foodLog', [id]);
  await touch('foods', [input.food.id]);
  return id;
}

export async function deleteFoodLogEntry(id: string): Promise<void> {
  await db.foodLog.delete(id);
  await tombstone('foodLog', [id]);
}

export async function foodLogForDate(date: IsoDate): Promise<FoodLogEntry[]> {
  const rows = await db.foodLog.where('date').equals(date).toArray();
  return rows.sort((a, b) => a.loggedAt.localeCompare(b.loggedAt));
}
