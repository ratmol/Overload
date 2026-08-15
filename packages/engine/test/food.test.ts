import { describe, expect, it } from 'vitest';
import {
  energyReconciles,
  macrosForGrams,
  proteinAdherence,
  reconcileIntake,
  resolvePortion,
  sumFoodLog,
  toIntakeEntry,
} from '../src/food.js';
import { estimateTdee } from '../src/tdee.js';
import { computeTrend } from '../src/trend.js';
import type { FoodItem, FoodLogEntry, IntakeEntry, WeightEntry } from '../src/types.js';

const chicken: FoodItem = {
  id: 'chicken',
  name: 'Chicken breast, cooked',
  per100g: { kcal: 165, proteinG: 31, carbsG: 0, fatG: 3.6 },
  portions: [{ label: '1 breast', grams: 174 }],
  source: 'usda',
  isFavourite: true,
};

function entry(over: Partial<FoodLogEntry> = {}): FoodLogEntry {
  return {
    id: 'e1',
    date: '2026-08-01',
    foodId: 'chicken',
    grams: 100,
    kcal: 165,
    proteinG: 31,
    carbsG: 0,
    fatG: 3.6,
    loggedAt: '2026-08-01T12:00:00.000Z',
    ...over,
  };
}

describe('macrosForGrams', () => {
  it('scales linearly from the per-100g basis', () => {
    expect(macrosForGrams(chicken, 200).kcal).toBeCloseTo(330);
    expect(macrosForGrams(chicken, 200).proteinG).toBeCloseTo(62);
  });

  it('handles odd gram amounts, which is the normal case on a kitchen scale', () => {
    const m = macrosForGrams(chicken, 137);
    expect(m.kcal).toBeCloseTo(226.05, 2);
    expect(m.proteinG).toBeCloseTo(42.47, 2);
  });

  it('returns zeroes for zero grams rather than throwing', () => {
    expect(macrosForGrams(chicken, 0)).toMatchObject({ kcal: 0, proteinG: 0 });
  });

  it('rejects negative and non-finite weights loudly', () => {
    expect(() => macrosForGrams(chicken, -5)).toThrow(RangeError);
    expect(() => macrosForGrams(chicken, NaN)).toThrow(RangeError);
  });

  it('carries fibre only when the food has it', () => {
    expect(macrosForGrams(chicken, 100).fiberG).toBeUndefined();
    const oats: FoodItem = {
      ...chicken,
      id: 'oats',
      per100g: { kcal: 379, proteinG: 13, carbsG: 67, fatG: 7, fiberG: 10 },
    };
    expect(macrosForGrams(oats, 50).fiberG).toBeCloseTo(5);
  });
});

describe('resolvePortion', () => {
  it('resolves a named portion', () => {
    expect(resolvePortion(chicken, { portionLabel: '1 breast' })).toBe(174);
  });

  it('multiplies a named portion by a count', () => {
    expect(resolvePortion(chicken, { portionLabel: '1 breast', count: 2 })).toBe(348);
  });

  it('prefers an explicit weight over a named portion', () => {
    expect(resolvePortion(chicken, { portionLabel: '1 breast', grams: 150 })).toBe(150);
  });

  it('returns null for an unknown label instead of guessing', () => {
    // Guessing 100 g writes a wrong meal into a log that feeds calorie
    // decisions, and it looks entirely plausible afterwards.
    expect(resolvePortion(chicken, { portionLabel: '1 thigh' })).toBeNull();
  });

  it('returns null for a request that says nothing', () => {
    expect(resolvePortion(chicken, {})).toBeNull();
  });

  it('rejects non-positive amounts', () => {
    expect(resolvePortion(chicken, { grams: 0 })).toBeNull();
    expect(resolvePortion(chicken, { portionLabel: '1 breast', count: -1 })).toBeNull();
  });
});

describe('sumFoodLog', () => {
  it('sums an empty day to zero', () => {
    expect(sumFoodLog([])).toEqual({ kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 });
  });

  it('is indifferent to how a day was split up', () => {
    // The property that matters: one 1200 kcal row and twelve 100 kcal rows
    // must produce the same day.
    const one = [entry({ kcal: 1200, proteinG: 120, carbsG: 100, fatG: 40 })];
    const many = Array.from({ length: 12 }, (_, i) =>
      entry({ id: `m${i}`, kcal: 100, proteinG: 10, carbsG: 100 / 12, fatG: 40 / 12 }),
    );
    const a = sumFoodLog(one);
    const b = sumFoodLog(many);
    expect(b.kcal).toBeCloseTo(a.kcal);
    expect(b.proteinG).toBeCloseTo(a.proteinG);
    expect(b.carbsG).toBeCloseTo(a.carbsG);
    expect(b.fatG).toBeCloseTo(a.fatG);
  });
});

describe('toIntakeEntry', () => {
  it('derives a stable id from the date, because it is never stored', () => {
    const a = toIntakeEntry('2026-08-01', [entry()], 'off');
    const b = toIntakeEntry('2026-08-01', [entry()], 'off');
    expect(a.id).toBe('food:2026-08-01');
    expect(a.id).toBe(b.id);
  });

  it('produces something the calorie engine already understands', () => {
    const e = toIntakeEntry('2026-08-01', [entry({ kcal: 800, proteinG: 60 })], 'shift');
    expect(e).toMatchObject({ date: '2026-08-01', calories: 800, proteinG: 60, activityTag: 'shift' });
  });
});

describe('reconcileIntake', () => {
  const intakeRow = (date: string, calories: number): IntakeEntry => ({
    id: `i-${date}`,
    date,
    calories,
    proteinG: 100,
    carbsG: 200,
    fatG: 70,
    source: 'import',
    activityTag: 'shift',
  });

  it('passes intake rows through untouched when there is no food log', () => {
    const rows = [intakeRow('2026-08-01', 2400)];
    expect(reconcileIntake(rows, []).entries).toEqual(rows);
  });

  it('lets food rows win on a day recorded in both', () => {
    // The failure this prevents: concatenating both tables double-counts the
    // day, which moves estimated expenditure by about a day's eating.
    const result = reconcileIntake(
      [intakeRow('2026-08-01', 2400)],
      [entry({ date: '2026-08-01', kcal: 1800 })],
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.calories).toBe(1800);
  });

  it('inherits the activity tag from the intake row it supersedes', () => {
    const result = reconcileIntake(
      [intakeRow('2026-08-01', 2400)],
      [entry({ date: '2026-08-01', kcal: 1800 })],
    );
    expect(result.entries[0]!.activityTag).toBe('shift');
    expect(result.untaggedDates).toEqual([]);
  });

  it('reports days whose tag had to be assumed rather than hiding them', () => {
    // Calories are unaffected by the tag, so the day still counts toward TDEE.
    // The shift/off comparison is entirely about the tag, so the caller has to
    // be able to exclude these.
    const result = reconcileIntake([], [entry({ date: '2026-08-02' })]);
    expect(result.untaggedDates).toEqual(['2026-08-02']);
    expect(result.entries).toHaveLength(1);
  });

  it('prefers an explicit tag resolver over the superseded row', () => {
    const result = reconcileIntake(
      [intakeRow('2026-08-01', 2400)],
      [entry({ date: '2026-08-01' })],
      { tagFor: () => 'off' },
    );
    expect(result.entries[0]!.activityTag).toBe('off');
    expect(result.untaggedDates).toEqual([]);
  });

  it('merges both tables across different days, sorted', () => {
    const result = reconcileIntake(
      [intakeRow('2026-08-03', 2400), intakeRow('2026-08-01', 2300)],
      [entry({ date: '2026-08-02', kcal: 2000 })],
    );
    expect(result.entries.map((e) => e.date)).toEqual([
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
    ]);
  });

  it('keeps estimateTdee working with no change to estimateTdee', () => {
    // The seam. A day logged as twelve food rows and a day imported as one row
    // must produce the same expenditure estimate.
    const weights: WeightEntry[] = Array.from({ length: 60 }, (_, i) => ({
      id: `w${i}`,
      date: `2026-0${i < 31 ? '7' : '8'}-${String((i % 31) + 1).padStart(2, '0')}`,
      weightLb: 132 + i * 0.05,
      source: 'manual',
      flaggedOutlier: false,
    }));
    const trend = computeTrend(weights);
    const today = weights[weights.length - 1]!.date;

    const asImport: IntakeEntry[] = weights.map((w) => intakeRow(w.date, 2400));
    const asFood: FoodLogEntry[] = weights.flatMap((w, i) =>
      Array.from({ length: 4 }, (_, j) =>
        entry({ id: `f${i}-${j}`, date: w.date, kcal: 600, proteinG: 40, carbsG: 50, fatG: 17.5 }),
      ),
    );

    const fromImport = estimateTdee({ today, trend, intake: asImport, goalType: 'gain' });
    const reconciled = reconcileIntake([], asFood, { assumedTag: 'shift' });
    const fromFood = estimateTdee({ today, trend, intake: reconciled.entries, goalType: 'gain' });

    expect(fromFood!.kcal).toBe(fromImport!.kcal);
    expect(fromFood!.loggedDays).toBe(fromImport!.loggedDays);
  });
});

describe('proteinAdherence', () => {
  it('reports a hit', () => {
    const r = proteinAdherence([entry({ proteinG: 160 })], 150);
    expect(r.met).toBe(true);
    expect(r.shortfallG).toBe(0);
    expect(r.reason).toContain('160 g against a 150 g target');
  });

  it('reports how far short, and why it matters', () => {
    const r = proteinAdherence([entry({ proteinG: 96 })], 150);
    expect(r.met).toBe(false);
    expect(r.shortfallG).toBe(54);
    expect(r.reason).toContain('54 g short');
  });

  it('treats an empty day as a total miss rather than a pass', () => {
    const r = proteinAdherence([], 150);
    expect(r.met).toBe(false);
    expect(r.shortfallG).toBe(150);
  });

  it('sums across every row in the day', () => {
    const rows = Array.from({ length: 5 }, (_, i) => entry({ id: `p${i}`, proteinG: 30 }));
    expect(proteinAdherence(rows, 150).met).toBe(true);
  });
});

describe('energyReconciles', () => {
  it('passes a real food label', () => {
    // Chicken breast, cooked, per 100g: standard USDA-ish figures.
    const r = energyReconciles({ kcal: 165, proteinG: 31, carbsG: 0, fatG: 3.6 });
    expect(r.reconciles).toBe(true);
    expect(r.impliedKcal).toBeCloseTo(31 * 4 + 3.6 * 9, 1);
  });

  it('passes within the default 20% tolerance', () => {
    // Implied 400, stated 470 -> 17.5% over.
    const r = energyReconciles({ kcal: 470, proteinG: 40, carbsG: 40, fatG: 8 });
    expect(r.reconciles).toBe(true);
  });

  it('fails a barcode data-entry error', () => {
    // The case from the spec: an absurd macro relative to the stated energy.
    // 40 kcal stated against 20g of fat (180 implied) is not a rounding issue.
    const r = energyReconciles({ kcal: 40, proteinG: 0, carbsG: 0, fatG: 20 });
    expect(r.reconciles).toBe(false);
    expect(r.differenceFraction).toBeGreaterThan(0.5);
  });

  it('is signed: reports which direction the stated value is wrong', () => {
    const over = energyReconciles({ kcal: 1000, proteinG: 10, carbsG: 10, fatG: 10 });
    expect(over.differenceKcal).toBeGreaterThan(0);
    const under = energyReconciles({ kcal: 10, proteinG: 10, carbsG: 10, fatG: 10 });
    expect(under.differenceKcal).toBeLessThan(0);
  });

  it('does not flag a near-zero-calorie food on fractional noise', () => {
    // Black coffee: 2 kcal implied, 0 stated. As a FRACTION that is "100%
    // wrong" and would fail every time on a food that is fine.
    const r = energyReconciles({ kcal: 0, proteinG: 0, carbsG: 0.5, fatG: 0 });
    expect(r.reconciles).toBe(true);
  });

  it('still catches a real error on a near-zero-calorie food, by absolute gap', () => {
    const r = energyReconciles({ kcal: 200, proteinG: 0, carbsG: 0, fatG: 0 });
    expect(r.reconciles).toBe(false);
  });

  it('accepts a wider tolerance when asked', () => {
    const macros = { kcal: 470, proteinG: 40, carbsG: 40, fatG: 8 }; // 17.5% over
    expect(energyReconciles(macros, 0.1).reconciles).toBe(false);
    expect(energyReconciles(macros, 0.25).reconciles).toBe(true);
  });
});
