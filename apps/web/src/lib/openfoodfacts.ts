/**
 * Open Food Facts: barcode lookup. Free, no key, no signup — see
 * docs/FOOD-LOGGING-SPEC.md §5.2. This is why the barcode scanner can ship
 * before USDA text search, which needs an API key and a decision about where
 * that key lives.
 *
 * The parsing step is split from the fetch deliberately: `parseOffProduct` is
 * pure and is what gets tested. `lookupBarcode` is the network call and is not
 * unit-tested against the live API — the app's own convention (see csv.ts) is
 * that fetch belongs in apps/web and stays untested; the logic behind it does.
 */
import { energyReconciles, type FoodItem, type Macros } from '@overload/engine';

/**
 * OFF's terms require an identifying User-Agent, and they throttle anonymous
 * abuse. This is not a secret and does not need to be — it is a courtesy to
 * their infrastructure, not an auth token.
 */
const USER_AGENT = 'overload (local-first training logger; github.com/ratmol/Overload)';

interface OffNutriments {
  'energy-kcal_100g'?: number;
  proteins_100g?: number;
  carbohydrates_100g?: number;
  fat_100g?: number;
  fiber_100g?: number;
}

interface OffProduct {
  product_name?: string;
  brands?: string;
  nutriments?: OffNutriments;
}

interface OffResponse {
  status: number;
  product?: OffProduct;
}

export type BarcodeLookup =
  | { outcome: 'found'; candidate: BarcodeCandidate }
  | { outcome: 'not-found' }
  | { outcome: 'incomplete'; reason: string; partial: PartialCandidate }
  | { outcome: 'suspect'; candidate: BarcodeCandidate; reason: string }
  | { outcome: 'error'; reason: string };

/** Enough to pre-fill AddFoodForm. Never written to the database as-is. */
export interface BarcodeCandidate {
  name: string;
  brand: string | undefined;
  per100g: Macros;
  barcode: string;
}

/**
 * Whatever a lookup could parse, even when it fell short of a full candidate.
 * "Drop the user into the manual-entry form pre-filled with whatever did
 * parse" — docs/FOOD-LOGGING-SPEC.md §5.2 — so a product with a name and three
 * of four macros should not make the form start from nothing.
 */
export interface PartialCandidate {
  name: string;
  brand: string | undefined;
  barcode: string;
  kcal: number | undefined;
  proteinG: number | undefined;
  carbsG: number | undefined;
  fatG: number | undefined;
}

/**
 * Turns OFF's raw JSON into a candidate, or explains why it could not.
 *
 * Exported and pure so it can be tested against fixtures without a network
 * call. Every field on a crowd-sourced record is optional in practice even
 * when the schema calls it required — "missing or absurd macros are common"
 * per the food spec — so this fails soft into `incomplete` rather than
 * throwing on a shape that does not match assumptions.
 */
export function parseOffProduct(barcode: string, raw: unknown): BarcodeLookup {
  const parsed = raw as Partial<OffResponse> | null | undefined;

  if (!parsed || typeof parsed !== 'object') {
    return { outcome: 'error', reason: 'Response was not a JSON object.' };
  }
  if (parsed.status !== 1 || !parsed.product) {
    return { outcome: 'not-found' };
  }

  const p = parsed.product;
  const n = p.nutriments ?? {};

  const kcal = n['energy-kcal_100g'];
  const proteinG = n.proteins_100g;
  const carbsG = n.carbohydrates_100g;
  const fatG = n.fat_100g;

  const isUsable = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const missing = (
    [
      ['calories', kcal],
      ['protein', proteinG],
      ['carbs', carbsG],
      ['fat', fatG],
    ] as const
  ).filter(([, v]) => !isUsable(v));

  if (missing.length > 0) {
    return {
      outcome: 'incomplete',
      reason: `Missing ${missing.map(([label]) => label).join(', ')} per 100g. Enter it by hand.`,
      partial: {
        name: p.product_name?.trim() || `Unnamed product (${barcode})`,
        brand: p.brands?.split(',')[0]?.trim() || undefined,
        barcode,
        kcal: isUsable(kcal) ? kcal : undefined,
        proteinG: isUsable(proteinG) ? proteinG : undefined,
        carbsG: isUsable(carbsG) ? carbsG : undefined,
        fatG: isUsable(fatG) ? fatG : undefined,
      },
    };
  }

  const per100g: Macros = {
    kcal: kcal!,
    proteinG: proteinG!,
    carbsG: carbsG!,
    fatG: fatG!,
    ...(typeof n.fiber_100g === 'number' && Number.isFinite(n.fiber_100g)
      ? { fiberG: n.fiber_100g }
      : {}),
  };

  const candidate: BarcodeCandidate = {
    name: p.product_name?.trim() || `Unnamed product (${barcode})`,
    brand: p.brands?.split(',')[0]?.trim() || undefined,
    per100g,
    barcode,
  };

  // Crowd-sourced macros that do not add up are a data-entry error, not a
  // food. Saving one verbatim writes a wrong number into every day it gets
  // logged on. Route it to manual entry, pre-filled, with a stated reason —
  // never a silent save.
  const check = energyReconciles(per100g);
  if (!check.reconciles) {
    const direction = check.differenceKcal > 0 ? 'higher' : 'lower';
    return {
      outcome: 'suspect',
      candidate,
      reason: `Listed as ${Math.round(per100g.kcal)} kcal/100g, but the macros imply about ${Math.round(check.impliedKcal)} — ${Math.round(check.differenceFraction * 100)}% ${direction}. Likely a data-entry error on the product page. Check the numbers before saving.`,
    };
  }

  return { outcome: 'found', candidate };
}

export async function lookupBarcode(barcode: string): Promise<BarcodeLookup> {
  let response: Response;
  try {
    response = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`,
      { headers: { 'User-Agent': USER_AGENT } },
    );
  } catch {
    return { outcome: 'error', reason: 'Could not reach Open Food Facts. Check the connection.' };
  }

  if (!response.ok) {
    return { outcome: 'error', reason: `Open Food Facts returned ${response.status}.` };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { outcome: 'error', reason: 'Open Food Facts returned something unreadable.' };
  }

  return parseOffProduct(barcode, json);
}

/** A FoodItem ready to store, from a lookup the caller has already accepted. */
export function candidateToFoodItem(candidate: BarcodeCandidate): Omit<FoodItem, 'id'> {
  return {
    name: candidate.name,
    ...(candidate.brand ? { brand: candidate.brand } : {}),
    barcode: candidate.barcode,
    per100g: candidate.per100g,
    portions: [],
    source: 'openfoodfacts',
    sourceId: candidate.barcode,
    isFavourite: false,
  };
}
