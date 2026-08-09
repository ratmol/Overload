import { describe, expect, it } from 'vitest';
import { detectSource, normaliseDate, parseIntakeCsv, splitCsvLine } from '../src/lib/csv.js';

describe('splitCsvLine', () => {
  it('splits plain fields', () => {
    expect(splitCsvLine('2026-08-08,2400,150,250,80')).toEqual([
      '2026-08-08',
      '2400',
      '150',
      '250',
      '80',
    ]);
  });

  it('keeps commas inside quoted fields', () => {
    // The whole reason this function exists. A naive split shifts every column
    // after a food name by one and produces plausible-looking garbage.
    expect(splitCsvLine('2026-08-08,"Bread, whole wheat",120')).toEqual([
      '2026-08-08',
      'Bread, whole wheat',
      '120',
    ]);
  });

  it('unescapes doubled quotes', () => {
    expect(splitCsvLine('a,"say ""hi""",b')).toEqual(['a', 'say "hi"', 'b']);
  });

  it('preserves empty trailing fields', () => {
    expect(splitCsvLine('a,,c,')).toEqual(['a', '', 'c', '']);
  });
});

describe('normaliseDate', () => {
  it('passes ISO dates through', () => {
    expect(normaliseDate('2026-08-08')).toBe('2026-08-08');
  });

  it('strips a time component', () => {
    expect(normaliseDate('2026-08-08 07:30')).toBe('2026-08-08');
    expect(normaliseDate('2026-08-08T07:30:00Z')).toBe('2026-08-08');
  });

  it('reads a named month', () => {
    expect(normaliseDate('Aug 8, 2026')).toBe('2026-08-08');
  });

  it('refuses ambiguous numeric dates rather than guessing', () => {
    // 03/04/2026 is March 4th in one locale and April 3rd in another. Picking
    // one silently would shift a month of intake onto the wrong days, and the
    // resulting TDEE would look entirely reasonable.
    expect(normaliseDate('03/04/2026')).toBeNull();
    expect(normaliseDate('8/8/26')).toBeNull();
  });

  it('returns null on junk', () => {
    expect(normaliseDate('')).toBeNull();
    expect(normaliseDate('not a date')).toBeNull();
  });
});

describe('detectSource', () => {
  it('recognises a Cronometer per-food export', () => {
    expect(detectSource(['Day', 'Food Name', 'Amount', 'Energy (kcal)'])).toBe('cronometer');
  });

  it('recognises a MacroFactor daily export', () => {
    expect(detectSource(['Date', 'Calories', 'Protein (g)', 'Carbs (g)', 'Fat (g)'])).toBe(
      'macrofactor',
    );
  });

  it('falls back to generic', () => {
    expect(detectSource(['when', 'kcal'])).toBe('generic');
  });
});

describe('parseIntakeCsv', () => {
  const macrofactor = [
    'Date,Calories,Protein (g),Carbs (g),Fat (g)',
    '2026-08-01,2450,152,260,78',
    '2026-08-02,2380,148,251,74',
  ].join('\n');

  it('reads a MacroFactor daily export', () => {
    const result = parseIntakeCsv(macrofactor, 'off');
    expect(result.source).toBe('macrofactor');
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toEqual({
      date: '2026-08-01',
      calories: 2450,
      proteinG: 152,
      carbsG: 260,
      fatG: 78,
      source: 'import',
      activityTag: 'off',
    });
    expect(result.dates).toEqual(['2026-08-01', '2026-08-02']);
  });

  it('keeps Cronometer per-food rows rather than summing them', () => {
    // estimateTdee aggregates to daily totals itself and documents that
    // multiple rows per day are legal. Summing here would discard detail and
    // create a second implementation of the same arithmetic to disagree with.
    const cronometer = [
      'Day,Food Name,Energy (kcal),Protein (g),Carbs (g),Fat (g)',
      '2026-08-01,"Oats, rolled",380,13,66,7',
      '2026-08-01,"Chicken breast, raw",520,98,0,12',
    ].join('\n');

    const result = parseIntakeCsv(cronometer, 'shift');
    expect(result.source).toBe('cronometer');
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.calories)).toEqual([380, 520]);
    expect(result.dates).toEqual(['2026-08-01']);
    expect(result.entries.every((e) => e.activityTag === 'shift')).toBe(true);
  });

  it('reports unreadable rows instead of dropping them silently', () => {
    const messy = [
      'Date,Calories',
      '2026-08-01,2450',
      'not-a-date,2000',
      '2026-08-03,rubbish',
    ].join('\n');

    const result = parseIntakeCsv(messy, 'off');
    expect(result.entries).toHaveLength(1);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]!.line).toBe(3);
    expect(result.skipped[1]!.line).toBe(4);
  });

  it('skips zero-calorie rows, which are water entries or blank days', () => {
    const result = parseIntakeCsv(['Date,Calories', '2026-08-01,0'].join('\n'), 'off');
    expect(result.entries).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('handles thousands separators and unit suffixes', () => {
    const result = parseIntakeCsv(
      ['Date,Calories,Protein (g)', '2026-08-01,"2,450",152g'].join('\n'),
      'off',
    );
    expect(result.entries[0]!.calories).toBe(2450);
    expect(result.entries[0]!.proteinG).toBe(152);
  });

  it('defaults missing macro columns to zero rather than failing', () => {
    // Some exports carry calories only. That is still usable for TDEE, which
    // reads nothing but the calorie column.
    const result = parseIntakeCsv(['Date,Calories', '2026-08-01,2450'].join('\n'), 'off');
    expect(result.entries[0]).toMatchObject({ calories: 2450, proteinG: 0, carbsG: 0, fatG: 0 });
  });

  it('fails loudly when the header has no recognisable columns', () => {
    const result = parseIntakeCsv(['alpha,beta', '1,2'].join('\n'), 'off');
    expect(result.entries).toHaveLength(0);
    expect(result.skipped[0]!.reason).toContain('Could not find');
  });

  it('handles an empty file', () => {
    expect(parseIntakeCsv('', 'off').skipped[0]!.reason).toContain('empty');
  });
});
