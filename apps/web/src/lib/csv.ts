/**
 * CSV import for Cronometer and MacroFactor exports.
 *
 * Pure functions over a string. No Dexie, no React, no DOM — the whole point is
 * that the awkward part (someone else's column names) is testable without a
 * browser, and it is tested in `csv.test.ts`.
 *
 * Two shapes have to be handled and they are genuinely different:
 *
 *  - **MacroFactor** exports one row per day, already totalled.
 *  - **Cronometer** exports one row per food entry, several per day.
 *
 * Rather than collapse Cronometer's rows at import, both are kept as-is. The
 * engine's `estimateTdee` aggregates to daily totals itself and documents that
 * multiple rows per day are legal, so summing here would only throw away detail
 * and add a place for the two implementations to disagree.
 */
import { IsoDate } from '@overload/engine';
import type { ActivityTag, IntakeEntry } from '@overload/engine';

export type CsvSource = 'cronometer' | 'macrofactor' | 'generic';

export interface ParsedIntake {
  source: CsvSource;
  entries: Omit<IntakeEntry, 'id'>[];
  /** Rows that could not be read, with the reason. Never silently dropped. */
  skipped: { line: number; reason: string }[];
  /** Distinct calendar dates covered. */
  dates: string[];
}

/**
 * Splits one CSV line, honouring double-quoted fields and doubled quotes.
 *
 * Written out rather than `line.split(',')` because Cronometer food names
 * contain commas constantly ("Bread, whole wheat") and a naive split shifts
 * every column after them by one, which produces plausible-looking garbage
 * instead of an error.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/** Header candidates, lowercased, in priority order. */
const COLUMNS = {
  date: ['date', 'day', 'day of week', 'date (yyyy-mm-dd)'],
  calories: ['energy (kcal)', 'calories', 'energy', 'kcal', 'calories (kcal)'],
  protein: ['protein (g)', 'protein', 'protein_g'],
  carbs: ['carbs (g)', 'carbohydrates (g)', 'net carbs (g)', 'carbs', 'carbohydrates'],
  fat: ['fat (g)', 'fat', 'total fat (g)', 'fat_g'],
} as const;

function findColumn(header: readonly string[], candidates: readonly string[]): number {
  const lower = header.map((h) => h.toLowerCase().trim());
  for (const candidate of candidates) {
    const exact = lower.indexOf(candidate);
    if (exact !== -1) return exact;
  }
  // Fall back to a prefix match, because both exporters have changed their
  // column labels between versions ("Energy (kcal)" became "Energy" and back).
  for (const candidate of candidates) {
    const partial = lower.findIndex((h) => h.startsWith(candidate));
    if (partial !== -1) return partial;
  }
  return -1;
}

export function detectSource(header: readonly string[]): CsvSource {
  const joined = header.join('|').toLowerCase();
  // Cronometer's per-food export always carries a food description column.
  if (joined.includes('food name') || joined.includes('food_name')) return 'cronometer';
  if (joined.includes('energy (kcal)') && joined.includes('day')) return 'cronometer';
  if (joined.includes('calories') && joined.includes('date')) return 'macrofactor';
  return 'generic';
}

/**
 * Normalises the date formats the two exporters actually emit.
 * Anything ambiguous is rejected rather than guessed: `03/04/2026` is March 4th
 * to one exporter and April 3rd to the other, and quietly picking one would
 * shift a month of intake onto the wrong days.
 */
export function normaliseDate(raw: string): string | null {
  const value = raw.trim();
  if (IsoDate.safeParse(value).success) return value;

  // 2026-08-08 12:30, or 2026-08-08T12:30:00Z
  const isoPrefix = /^(\d{4}-\d{2}-\d{2})[T ]/.exec(value);
  if (isoPrefix) return isoPrefix[1]!;

  // 8 Aug 2026 / Aug 8, 2026
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed) && /[A-Za-z]{3}/.test(value)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }

  return null;
}

function toNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  // Exports carry thousands separators and stray units.
  const cleaned = raw.replace(/[, ]/g, '').replace(/kcal|g$/i, '');
  if (cleaned === '') return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function parseIntakeCsv(text: string, defaultTag: ActivityTag): ParsedIntake {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');

  const skipped: { line: number; reason: string }[] = [];
  if (lines.length < 2) {
    return { source: 'generic', entries: [], skipped: [{ line: 0, reason: 'File is empty.' }], dates: [] };
  }

  const header = splitCsvLine(lines[0]!);
  const source = detectSource(header);

  const idx = {
    date: findColumn(header, COLUMNS.date),
    calories: findColumn(header, COLUMNS.calories),
    protein: findColumn(header, COLUMNS.protein),
    carbs: findColumn(header, COLUMNS.carbs),
    fat: findColumn(header, COLUMNS.fat),
  };

  if (idx.date === -1 || idx.calories === -1) {
    return {
      source,
      entries: [],
      skipped: [
        {
          line: 1,
          reason: `Could not find a date and a calories column. Header was: ${header.join(', ')}`,
        },
      ],
      dates: [],
    };
  }

  const entries: Omit<IntakeEntry, 'id'>[] = [];
  const dates = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const date = normaliseDate(cells[idx.date] ?? '');
    if (date === null) {
      skipped.push({ line: i + 1, reason: `Unreadable date "${cells[idx.date] ?? ''}"` });
      continue;
    }

    const calories = toNumber(cells[idx.calories]);
    if (calories === null || calories < 0) {
      skipped.push({ line: i + 1, reason: `Unreadable calories "${cells[idx.calories] ?? ''}"` });
      continue;
    }

    // A zero-calorie row is a water entry or a blank day, not information.
    if (calories === 0) continue;

    entries.push({
      date,
      calories,
      proteinG: Math.max(0, (idx.protein === -1 ? null : toNumber(cells[idx.protein])) ?? 0),
      carbsG: Math.max(0, (idx.carbs === -1 ? null : toNumber(cells[idx.carbs])) ?? 0),
      fatG: Math.max(0, (idx.fat === -1 ? null : toNumber(cells[idx.fat])) ?? 0),
      source: 'import',
      activityTag: defaultTag,
    });
    dates.add(date);
  }

  return { source, entries, skipped, dates: [...dates].sort() };
}
