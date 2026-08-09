/**
 * Intake: import a food log, add a day by hand, tag days shift or off.
 *
 * There is no food database here and there is not going to be one. This app's
 * job is to read what Cronometer or MacroFactor already recorded and turn it
 * into something the engine can estimate from.
 */
import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ActivityTag } from '@overload/engine';
import { db } from '../../db/db.js';
import { logIntakeManually, replaceIntakeForDates, tagDay } from '../../db/nutrition.js';
import { todayIso } from '../../db/queries.js';
import { parseIntakeCsv, type ParsedIntake } from '../../lib/csv.js';
import { shortDate } from '../../lib/format.js';
import { go } from '../../lib/route.js';

export function IntakeScreen() {
  const today = todayIso();
  const fileInput = useRef<HTMLInputElement>(null);
  const [defaultTag, setDefaultTag] = useState<ActivityTag>('off');
  const [preview, setPreview] = useState<ParsedIntake | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [manual, setManual] = useState({ date: today, calories: '', protein: '', carbs: '', fat: '' });

  // Daily totals, newest first. Multiple rows per day are legal — Cronometer
  // exports one per food — so they are summed for display only.
  const days = useLiveQuery(async () => {
    const rows = await db.intake.orderBy('date').reverse().toArray();
    const byDate = new Map<string, { kcal: number; tag: ActivityTag; rows: number }>();
    for (const r of rows) {
      const existing = byDate.get(r.date);
      if (existing) {
        existing.kcal += r.calories;
        existing.rows += 1;
      } else {
        byDate.set(r.date, { kcal: r.calories, tag: r.activityTag, rows: 1 });
      }
    }
    return [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  });

  async function onFile(file: File) {
    setMessage(null);
    const parsed = parseIntakeCsv(await file.text(), defaultTag);
    setPreview(parsed);
  }

  async function confirmImport(parsed: ParsedIntake) {
    const result = await replaceIntakeForDates(parsed.dates, parsed.entries);
    setPreview(null);
    setMessage(
      `Imported ${result.added} rows across ${parsed.dates.length} days` +
        (result.replaced > 0 ? `, replacing ${result.replaced} existing rows on those days.` : '.'),
    );
  }

  async function onManualSubmit(event: React.FormEvent) {
    event.preventDefault();
    const calories = Number(manual.calories);
    if (!Number.isFinite(calories) || calories <= 0) return;
    await logIntakeManually({
      date: manual.date,
      calories,
      proteinG: Number(manual.protein) || 0,
      carbsG: Number(manual.carbs) || 0,
      fatG: Number(manual.fat) || 0,
      activityTag: defaultTag,
    });
    setManual({ date: today, calories: '', protein: '', carbs: '', fat: '' });
    setMessage('Day saved.');
  }

  return (
    <main>
      <button className="link-back" onClick={() => go('/body')}>
        ← Body
      </button>

      <section className="sheet">
        <p className="eyebrow">Intake</p>
        <h1>Import a food log</h1>
        <p className="hint">
          Export a CSV from Cronometer or MacroFactor. Re-importing an overlapping range is
          safe — the days in the file replace the days already stored, rather than stacking on
          top of them and doubling your intake.
        </p>

        <div className="field">
          <label>Tag these days as</label>
          <div className="segmented">
            {(['off', 'shift'] as const).map((tag) => (
              <button
                key={tag}
                type="button"
                aria-pressed={defaultTag === tag}
                onClick={() => setDefaultTag(tag)}
              >
                {tag === 'off' ? 'Off day' : 'Shift day'}
              </button>
            ))}
          </div>
          <p className="hint">
            No exporter records this, so it has to be set here. Fix individual days in the list
            below — the shift/off split is worthless if the tags are wrong.
          </p>
        </div>

        <div className="btn-row">
          <button className="btn" onClick={() => fileInput.current?.click()}>
            Choose CSV
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void onFile(file);
            }}
          />
        </div>

        {preview && (
          <div className="notice">
            <strong>
              {preview.entries.length} rows, {preview.dates.length} days
              {preview.source !== 'generic' && ` · looks like ${preview.source}`}
            </strong>
            {preview.dates.length > 0 && (
              <p className="hint">
                {shortDate(preview.dates[0]!)} to {shortDate(preview.dates[preview.dates.length - 1]!)}
              </p>
            )}
            {preview.skipped.length > 0 && (
              <p className="hint">
                {preview.skipped.length} rows could not be read and will be left out:
                <br />
                {preview.skipped.slice(0, 3).map((s) => `line ${s.line}: ${s.reason}`).join('; ')}
                {preview.skipped.length > 3 && ` …and ${preview.skipped.length - 3} more`}
              </p>
            )}
            <div className="btn-row">
              <button
                className="btn"
                disabled={preview.entries.length === 0}
                onClick={() => void confirmImport(preview)}
              >
                Import
              </button>
              <button className="btn" data-tone="quiet" onClick={() => setPreview(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {message && <p className="hint">{message}</p>}
      </section>

      <section className="sheet">
        <p className="eyebrow">Add a day by hand</p>
        <form onSubmit={onManualSubmit}>
          <div className="field">
            <label htmlFor="intake-date">Date</label>
            <input
              id="intake-date"
              type="date"
              value={manual.date}
              onChange={(e) => setManual({ ...manual, date: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="intake-kcal">Calories</label>
            <input
              id="intake-kcal"
              type="number"
              inputMode="numeric"
              value={manual.calories}
              onChange={(e) => setManual({ ...manual, calories: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Protein / carbs / fat, g (optional)</label>
            <div className="field-pair">
              <input
                type="number"
                inputMode="numeric"
                aria-label="Protein grams"
                value={manual.protein}
                onChange={(e) => setManual({ ...manual, protein: e.target.value })}
              />
              <input
                type="number"
                inputMode="numeric"
                aria-label="Carb grams"
                value={manual.carbs}
                onChange={(e) => setManual({ ...manual, carbs: e.target.value })}
              />
              <input
                type="number"
                inputMode="numeric"
                aria-label="Fat grams"
                value={manual.fat}
                onChange={(e) => setManual({ ...manual, fat: e.target.value })}
              />
            </div>
          </div>
          <div className="btn-row">
            <button className="btn" type="submit">
              Save day
            </button>
          </div>
        </form>
      </section>

      <section className="sheet">
        <p className="eyebrow">Logged days</p>
        {!days || days.length === 0 ? (
          <div className="empty">Nothing yet.</div>
        ) : (
          days.slice(0, 60).map(([date, day]) => (
            <div className="intake-row" key={date}>
              <span className="history-date">{shortDate(date)}</span>
              <span>
                <strong>{Math.round(day.kcal)}</strong> kcal
                {day.rows > 1 && <span className="muted"> · {day.rows} entries</span>}
              </span>
              <div className="segmented segmented-tight">
                {(['off', 'shift'] as const).map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    aria-pressed={day.tag === tag}
                    onClick={() => void tagDay(date, tag)}
                  >
                    {tag === 'off' ? 'Off' : 'Shift'}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </section>
    </main>
  );
}
