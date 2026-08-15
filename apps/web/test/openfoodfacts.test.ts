import { describe, expect, it } from 'vitest';
import { candidateToFoodItem, parseOffProduct } from '../src/lib/openfoodfacts.js';

/** Trimmed from a real `GET /api/v2/product/3017620422003.json` response. */
const NUTELLA = {
  status: 1,
  product: {
    product_name: 'Nutella',
    brands: 'Nutella, Ferrero, Yum yum',
    nutriments: {
      'energy-kcal_100g': 539,
      proteins_100g: 6.3,
      carbohydrates_100g: 57.5,
      fat_100g: 30.9,
    },
  },
};

/** Real response shape for a diet drink: near-zero calories, protein zero. */
const DIET_COLA = {
  status: 1,
  product: {
    product_name: 'Coca-Cola Light',
    nutriments: {
      'energy-kcal_100g': 0.2,
      proteins_100g: 0,
      carbohydrates_100g: 0,
      fat_100g: 0,
    },
  },
};

/** Real response shape for an unknown barcode. */
const NOT_FOUND = { status: 0, status_verbose: 'no code or invalid code' };

describe('parseOffProduct', () => {
  it('parses a well-formed product', () => {
    const r = parseOffProduct('3017620422003', NUTELLA);
    expect(r.outcome).toBe('found');
    if (r.outcome !== 'found') throw new Error('unreachable');
    expect(r.candidate).toEqual({
      name: 'Nutella',
      brand: 'Nutella',
      barcode: '3017620422003',
      per100g: { kcal: 539, proteinG: 6.3, carbsG: 57.5, fatG: 30.9 },
    });
  });

  it('takes only the first brand off a comma-separated list', () => {
    // OFF's `brands` field is frequently "Brand, Parent Co, Regional Name".
    const r = parseOffProduct('x', NUTELLA);
    if (r.outcome !== 'found') throw new Error('unreachable');
    expect(r.candidate.brand).toBe('Nutella');
  });

  it('reports not-found on OFF status 0', () => {
    expect(parseOffProduct('0000000000000', NOT_FOUND)).toEqual({ outcome: 'not-found' });
  });

  it('accepts a real near-zero-calorie product', () => {
    // The exact case energyReconciles has a special branch for. If this ever
    // regresses, every diet drink gets routed to manual entry as "suspect".
    const r = parseOffProduct('5000112548167', DIET_COLA);
    expect(r.outcome).toBe('found');
  });

  it('fails soft on a non-object response rather than throwing', () => {
    expect(parseOffProduct('x', null).outcome).toBe('error');
    expect(parseOffProduct('x', 'not json').outcome).toBe('error');
    expect(parseOffProduct('x', undefined).outcome).toBe('error');
  });

  it('reports which fields are missing, and does not guess them', () => {
    // Crowd-sourced data with the fat field simply absent, which is common.
    const partial = {
      status: 1,
      product: {
        product_name: 'Mystery Snack',
        nutriments: { 'energy-kcal_100g': 200, proteins_100g: 5, carbohydrates_100g: 20 },
      },
    };
    const r = parseOffProduct('x', partial);
    expect(r.outcome).toBe('incomplete');
    if (r.outcome !== 'incomplete') throw new Error('unreachable');
    expect(r.reason).toContain('fat');
    expect(r.reason).not.toContain('protein');
    // Spec: "drop the user into the manual-entry form pre-filled with
    // whatever did parse." The name and the three good macros must survive.
    expect(r.partial.name).toBe('Mystery Snack');
    expect(r.partial.kcal).toBe(200);
    expect(r.partial.proteinG).toBe(5);
    expect(r.partial.carbsG).toBe(20);
    expect(r.partial.fatG).toBeUndefined();
  });

  it('treats a non-finite macro the same as a missing one', () => {
    const broken = {
      status: 1,
      product: {
        product_name: 'Bad Row',
        nutriments: {
          'energy-kcal_100g': 200,
          proteins_100g: Number.NaN,
          carbohydrates_100g: 20,
          fat_100g: 5,
        },
      },
    };
    expect(parseOffProduct('x', broken).outcome).toBe('incomplete');
  });

  it('routes an unreconciled product to suspect, with a stated reason, not a silent save', () => {
    // The scenario the spec names directly: absurd macros relative to stated
    // energy, which is a data-entry error rather than a real food.
    const bad = {
      status: 1,
      product: {
        product_name: 'Miscoded Item',
        nutriments: {
          'energy-kcal_100g': 40,
          proteins_100g: 0,
          carbohydrates_100g: 0,
          fat_100g: 20,
        },
      },
    };
    const r = parseOffProduct('x', bad);
    expect(r.outcome).toBe('suspect');
    if (r.outcome !== 'suspect') throw new Error('unreachable');
    expect(r.candidate.per100g.kcal).toBe(40); // still returned, for the manual-entry prefill
    expect(r.reason).toMatch(/higher|lower/);
  });

  it('falls back to a barcode-based name when the product has none', () => {
    const nameless = {
      status: 1,
      product: {
        nutriments: {
          'energy-kcal_100g': 80, // 4*5 + 4*10 + 9*2 = 78 implied, within tolerance
          proteins_100g: 5,
          carbohydrates_100g: 10,
          fat_100g: 2,
        },
      },
    };
    const r = parseOffProduct('9999999999999', nameless);
    if (r.outcome !== 'found') throw new Error('unreachable');
    expect(r.candidate.name).toContain('9999999999999');
  });

  it('carries fibre when present and omits it when absent', () => {
    const withFibre = {
      status: 1,
      product: {
        product_name: 'Oats',
        nutriments: {
          'energy-kcal_100g': 379,
          proteins_100g: 13,
          carbohydrates_100g: 67,
          fat_100g: 7,
          fiber_100g: 10,
        },
      },
    };
    const r = parseOffProduct('x', withFibre);
    if (r.outcome !== 'found') throw new Error('unreachable');
    expect(r.candidate.per100g.fiberG).toBe(10);

    const withoutFibre = parseOffProduct('x', NUTELLA);
    if (withoutFibre.outcome !== 'found') throw new Error('unreachable');
    expect(withoutFibre.candidate.per100g.fiberG).toBeUndefined();
  });
});

describe('candidateToFoodItem', () => {
  it('marks the source as openfoodfacts and keeps the barcode as sourceId', () => {
    const item = candidateToFoodItem({
      name: 'Nutella',
      brand: 'Ferrero',
      barcode: '3017620422003',
      per100g: { kcal: 539, proteinG: 6.3, carbsG: 57.5, fatG: 30.9 },
    });
    expect(item.source).toBe('openfoodfacts');
    expect(item.sourceId).toBe('3017620422003');
    expect(item.isFavourite).toBe(false);
    expect(item.portions).toEqual([]);
  });

  it('omits brand rather than storing an empty string', () => {
    const item = candidateToFoodItem({
      name: 'Generic Thing',
      brand: undefined,
      barcode: '123',
      per100g: { kcal: 100, proteinG: 1, carbsG: 1, fatG: 1 },
    });
    expect('brand' in item).toBe(false);
  });
});
