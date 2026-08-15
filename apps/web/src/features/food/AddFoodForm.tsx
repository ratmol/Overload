/**
 * Add a food to the personal list, by hand or pre-filled from a barcode.
 *
 * Manually entered macros are never run through `energyReconciles` — a person
 * weighing their own food and typing the label's numbers is the ground truth
 * this project trusts. That check exists to catch a THIRD PARTY's data-entry
 * error on a crowd-sourced record, not to second-guess the person logging.
 */
import { useState } from 'react';
import { FoodItem } from '@overload/engine';
import { addFood } from '../../db/foods.js';
import type { PartialCandidate } from '../../lib/openfoodfacts.js';

export interface Prefill {
  name?: string;
  brand?: string;
  barcode?: string;
  kcal?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  /** Shown as a warning banner rather than silently accepted. */
  warning?: string;
}

export function partialCandidateToPrefill(p: PartialCandidate, warning?: string): Prefill {
  return {
    name: p.name,
    ...(p.brand ? { brand: p.brand } : {}),
    barcode: p.barcode,
    ...(p.kcal !== undefined ? { kcal: p.kcal } : {}),
    ...(p.proteinG !== undefined ? { proteinG: p.proteinG } : {}),
    ...(p.carbsG !== undefined ? { carbsG: p.carbsG } : {}),
    ...(p.fatG !== undefined ? { fatG: p.fatG } : {}),
    ...(warning ? { warning } : {}),
  };
}

const asStr = (n: number | undefined) => (n === undefined ? '' : String(n));

export function AddFoodForm({
  prefill,
  onSaved,
  onCancel,
}: {
  prefill?: Prefill;
  onSaved: (foodId: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(prefill?.name ?? '');
  const [brand, setBrand] = useState(prefill?.brand ?? '');
  const [kcal, setKcal] = useState(asStr(prefill?.kcal));
  const [protein, setProtein] = useState(asStr(prefill?.proteinG));
  const [carbs, setCarbs] = useState(asStr(prefill?.carbsG));
  const [fat, setFat] = useState(asStr(prefill?.fatG));
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const parsed = FoodItem.omit({ id: true }).safeParse({
      name: name.trim(),
      ...(brand.trim() ? { brand: brand.trim() } : {}),
      ...(prefill?.barcode ? { barcode: prefill.barcode } : {}),
      per100g: {
        kcal: Number(kcal),
        proteinG: Number(protein) || 0,
        carbsG: Number(carbs) || 0,
        fatG: Number(fat) || 0,
      },
      portions: [],
      source: prefill?.barcode ? 'openfoodfacts' : 'manual',
      ...(prefill?.barcode ? { sourceId: prefill.barcode } : {}),
      isFavourite: false,
    });

    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return;
    }

    const id = await addFood(parsed.data);
    onSaved(id);
  }

  return (
    <section className="sheet">
      <p className="eyebrow">{prefill?.barcode ? 'Confirm the food' : 'Add a food'}</p>

      {prefill?.warning && (
        <div className="notice">
          <strong>Check these numbers before saving</strong>
          <p className="hint">{prefill.warning}</p>
        </div>
      )}

      <form onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="food-name">Name</label>
          <input
            id="food-name"
            autoFocus={!prefill?.name}
            value={name}
            placeholder="Chicken breast, cooked"
            onChange={(e) => setName(e.target.value)}
          />
          <p className="hint">Cooked vs raw goes in the name — the two differ by ~30% in calories.</p>
        </div>

        <div className="field">
          <label htmlFor="food-brand">Brand (optional)</label>
          <input id="food-brand" value={brand} onChange={(e) => setBrand(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="food-kcal">Calories per 100g</label>
          <input
            id="food-kcal"
            type="number"
            inputMode="decimal"
            value={kcal}
            onChange={(e) => setKcal(e.target.value)}
          />
        </div>

        <div className="field">
          <label>Protein / carbs / fat per 100g, g</label>
          <div className="field-pair">
            <input
              type="number"
              inputMode="decimal"
              aria-label="Protein grams per 100g"
              value={protein}
              onChange={(e) => setProtein(e.target.value)}
            />
            <input
              type="number"
              inputMode="decimal"
              aria-label="Carb grams per 100g"
              value={carbs}
              onChange={(e) => setCarbs(e.target.value)}
            />
            <input
              type="number"
              inputMode="decimal"
              aria-label="Fat grams per 100g"
              value={fat}
              onChange={(e) => setFat(e.target.value)}
            />
          </div>
        </div>

        {error && <p className="hint" style={{ color: 'var(--mark)' }}>{error}</p>}

        <div className="btn-row">
          <button className="btn" type="submit">
            Save to my foods
          </button>
          <button className="btn" data-tone="quiet" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
