/**
 * The personal food list: search it, add to it, scan a barcode into it, and
 * log a portion of anything on it.
 *
 * There is no search over a 300k-food database here, on purpose — see
 * DECISIONS §16. This is a list of the forty things actually eaten, kept
 * small enough that scrolling through it is faster than typing a search.
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { macrosForGrams, type FoodItem, type Meal } from '@overload/engine';
import { listFoods, logFoodPortion, toggleFavourite } from '../../db/foods.js';
import { todayIso } from '../../db/queries.js';
import { lb } from '../../lib/format.js';
import { go } from '../../lib/route.js';
import { AddFoodForm, type Prefill } from './AddFoodForm.js';
import { BarcodeScanner } from './BarcodeScanner.js';

type Mode =
  | { kind: 'list' }
  | { kind: 'scan' }
  | { kind: 'add'; prefill?: Prefill }
  | { kind: 'log'; food: FoodItem };

const MEALS: { value: Meal; label: string }[] = [
  { value: 'meal1', label: 'Meal 1' },
  { value: 'meal2', label: 'Meal 2' },
  { value: 'meal3', label: 'Meal 3' },
  { value: 'snack', label: 'Snack' },
  { value: 'prebed', label: 'Pre-bed' },
];

export function FoodsScreen() {
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [query, setQuery] = useState('');

  const foods = useLiveQuery(() => listFoods(), []);

  if (mode.kind === 'scan') {
    return (
      <main>
        <BackLink onClick={() => setMode({ kind: 'list' })} />
        <BarcodeScanner
          onResult={(prefill) => setMode({ kind: 'add', prefill })}
          onCancel={() => setMode({ kind: 'list' })}
        />
      </main>
    );
  }

  if (mode.kind === 'add') {
    return (
      <main>
        <BackLink onClick={() => setMode({ kind: 'list' })} />
        <AddFoodForm
          {...(mode.prefill ? { prefill: mode.prefill } : {})}
          onSaved={() => setMode({ kind: 'list' })}
          onCancel={() => setMode({ kind: 'list' })}
        />
      </main>
    );
  }

  if (mode.kind === 'log') {
    return (
      <main>
        <BackLink onClick={() => setMode({ kind: 'list' })} />
        <LogPortion food={mode.food} onDone={() => setMode({ kind: 'list' })} />
      </main>
    );
  }

  const q = query.trim().toLowerCase();
  const visible = (foods ?? []).filter((f) => f.name.toLowerCase().includes(q));

  return (
    <main>
      <button className="link-back" onClick={() => go('/intake')}>
        ← Intake
      </button>

      <section className="sheet">
        <p className="eyebrow">Foods</p>
        <h1>Your list</h1>

        <div className="field">
          <label htmlFor="food-search">Search</label>
          <input
            id="food-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="chicken"
          />
        </div>

        <div className="btn-row">
          <button className="btn" onClick={() => setMode({ kind: 'add' })}>
            + Add food
          </button>
          <button className="btn" data-tone="quiet" onClick={() => setMode({ kind: 'scan' })}>
            Scan barcode
          </button>
        </div>
      </section>

      <section className="sheet">
        {!foods ? (
          <div className="empty">…</div>
        ) : foods.length === 0 ? (
          <div className="empty">
            Nothing on your list yet. Add your first food, or scan a barcode.
          </div>
        ) : visible.length === 0 ? (
          <div className="empty">Nothing matches &ldquo;{query}&rdquo;.</div>
        ) : (
          <div className="day-list">
            {visible.map((food) => (
              <FoodRow key={food.id} food={food} onLog={() => setMode({ kind: 'log', food })} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function FoodRow({ food, onLog }: { food: FoodItem; onLog: () => void }) {
  return (
    <div className="day-row food-row">
      <button className="food-row-main" onClick={onLog}>
        <span>
          <span className="day-row-name">{food.name}</span>
          {food.brand && <span className="muted"> · {food.brand}</span>}
          <br />
          <span className="day-row-meta">
            {lb(food.per100g.kcal)} kcal · {lb(food.per100g.proteinG)}p /{' '}
            {lb(food.per100g.carbsG)}c / {lb(food.per100g.fatG)}f per 100g
          </span>
        </span>
      </button>
      <button
        className="food-fav"
        data-active={food.isFavourite}
        aria-label={food.isFavourite ? 'Remove favourite' : 'Mark favourite'}
        onClick={() => void toggleFavourite(food.id, !food.isFavourite)}
      >
        ★
      </button>
    </div>
  );
}

function LogPortion({ food, onDone }: { food: FoodItem; onDone: () => void }) {
  const [grams, setGrams] = useState('100');
  const [meal, setMeal] = useState<Meal | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const parsedGrams = Number(grams);
  const valid = Number.isFinite(parsedGrams) && parsedGrams > 0;
  const preview = valid ? macrosForGrams(food, parsedGrams) : null;

  async function onLog() {
    if (!valid) return;
    setBusy(true);
    await logFoodPortion({ food, grams: parsedGrams, date: todayIso(), ...(meal ? { meal } : {}) });
    setBusy(false);
    onDone();
  }

  return (
    <section className="sheet">
      <p className="eyebrow">Log</p>
      <h1>{food.name}</h1>
      {food.brand && <p className="muted">{food.brand}</p>}

      {food.portions.length > 0 && (
        <div className="btn-row">
          {food.portions.map((p) => (
            <button key={p.label} className="btn" data-tone="quiet" onClick={() => setGrams(String(p.grams))}>
              {p.label} ({lb(p.grams)}g)
            </button>
          ))}
        </div>
      )}

      <div className="field">
        <label htmlFor="portion-grams">Grams</label>
        <input
          id="portion-grams"
          type="number"
          inputMode="decimal"
          value={grams}
          onChange={(e) => setGrams(e.target.value)}
        />
      </div>

      <div className="field">
        <label>Meal (optional)</label>
        <div className="segmented segmented-wrap">
          {MEALS.map((m) => (
            <button
              key={m.value}
              type="button"
              aria-pressed={meal === m.value}
              onClick={() => setMeal((cur) => (cur === m.value ? undefined : m.value))}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {preview && (
        <dl>
          <div className="stat-row">
            <dt>Calories</dt>
            <dd>{Math.round(preview.kcal)}</dd>
          </div>
          <div className="stat-row">
            <dt>Protein / carbs / fat</dt>
            <dd>
              {Math.round(preview.proteinG)}g / {Math.round(preview.carbsG)}g / {Math.round(preview.fatG)}g
            </dd>
          </div>
        </dl>
      )}

      <div className="btn-row">
        <button className="log-button" disabled={!valid || busy} onClick={() => void onLog()}>
          Log {valid ? `${lb(parsedGrams)}g` : ''}
        </button>
      </div>
    </section>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button className="link-back" onClick={onClick}>
      ← Foods
    </button>
  );
}
