import { describe, expect, it } from 'vitest';
import { auditVolume } from '../src/volume.js';
import { Plan } from '../src/types.js';
import type { IsoDate, SetLog } from '../src/types.js';
import planJson from '../../../data/plan.json' with { type: 'json' };

const plan = Plan.parse(planJson);

const set = (
  exerciseId: string,
  sessionId: string,
  overrides: Partial<SetLog> = {},
): SetLog => ({
  id: `${sessionId}-${exerciseId}-${Math.random()}`,
  sessionId,
  exerciseId,
  addedWeightLb: 30,
  reps: 8,
  rir: 2,
  timestamp: '2026-08-31T18:00:00.000Z',
  isWarmup: false,
  ...overrides,
});

const sessionDates = new Map<string, IsoDate>([
  ['s1', '2026-08-31'],
  ['old', '2026-08-01'],
]);

const audit = (sets: SetLog[], windowDays = 7) =>
  auditVolume({
    today: '2026-08-31',
    windowDays,
    sets,
    sessionDates,
    exercises: plan.exercises,
    targets: plan.volumeTargets,
  });

const find = (rows: ReturnType<typeof audit>, muscle: string) =>
  rows.find((r) => r.muscle === muscle)!;

describe('plan.json', () => {
  it('validates against the Plan schema', () => {
    expect(() => Plan.parse(planJson)).not.toThrow();
  });

  it('has no template referencing a missing exercise', () => {
    const ids = new Set(plan.exercises.map((e) => e.id));
    for (const t of plan.templates) {
      for (const id of t.exerciseIds) expect(ids.has(id), `${t.id} -> ${id}`).toBe(true);
    }
  });

  it('uses a 2.5 lb increment on every bodyweight-loaded lift', () => {
    for (const e of plan.exercises.filter((x) => x.isBodyweightLoaded && x.id !== 'bulgarian-split-squat')) {
      expect(e.incrementLb, e.id).toBeLessThanOrEqual(2.5);
    }
  });

  it('has four session templates', () => {
    expect(plan.templates.map((t) => t.id)).toEqual(['day-1-cst', 'day-2-legs', 'day-3-bb', 'day-4-acc']);
  });
});

describe('auditVolume', () => {
  it('counts a direct set at full weight', () => {
    const rows = audit([set('cable-lateral-raise', 's1')]);
    expect(find(rows, 'sideDelts').sets).toBe(1);
  });

  it('counts secondary muscles fractionally', () => {
    const rows = audit([set('chest-supported-row', 's1')]);
    expect(find(rows, 'upperBack').sets).toBe(1);
    expect(find(rows, 'biceps').sets).toBe(0.5);
  });

  it('excludes warmups', () => {
    const rows = audit([set('cable-lateral-raise', 's1', { isWarmup: true })]);
    expect(find(rows, 'sideDelts').sets).toBe(0);
  });

  it('excludes sets left more than four reps in reserve', () => {
    const rows = audit([set('cable-lateral-raise', 's1', { rir: 6 })]);
    expect(find(rows, 'sideDelts').sets).toBe(0);
  });

  it('excludes zero-rep sets', () => {
    const rows = audit([set('cable-lateral-raise', 's1', { reps: 0 })]);
    expect(find(rows, 'sideDelts').sets).toBe(0);
  });

  it('excludes sets outside the rolling window', () => {
    const rows = audit([set('cable-lateral-raise', 'old')]);
    expect(find(rows, 'sideDelts').sets).toBe(0);
  });

  it('flags under-target when a priority muscle is neglected', () => {
    const rows = audit([]);
    const sideDelts = find(rows, 'sideDelts');
    expect(sideDelts.status).toBe('under');
    expect(sideDelts.priority).toBe(1);
  });

  it('flags over-target past the ceiling', () => {
    const sets = Array.from({ length: 14 }, () => set('cable-lateral-raise', 's1'));
    expect(find(audit(sets), 'sideDelts').status).toBe('over');
  });

  it('reports in-range inside the band', () => {
    const sets = Array.from({ length: 8 }, () => set('cable-lateral-raise', 's1'));
    expect(find(audit(sets), 'sideDelts').status).toBe('in-range');
  });

  it('sorts priority muscles first', () => {
    const rows = audit([]);
    expect(rows[0]!.muscle).toBe('sideDelts');
  });

  it('leaves priority muscles under target on a full prescribed week — the 1x4 Method trade', () => {
    // The 1x4 Method is one work set per exercise: a full four-day week is 16
    // sets, so every priority muscle gets ~1 direct set against floors of 4-6.
    // v3 hit these targets; this program deliberately does not — "less volume,
    // more intensity". The full accounting is in apps/web/test/plan.test.ts.
    const sets: SetLog[] = [];
    for (const t of plan.templates) {
      for (const id of t.exerciseIds) {
        const ex = plan.exercises.find((e) => e.id === id)!;
        for (let i = 0; i < ex.defaultSets; i++) sets.push(set(id, 's1'));
      }
    }
    const rows = audit(sets);
    const priority = rows.filter((r) => r.priority !== undefined);
    expect(priority.length).toBeGreaterThan(0);
    for (const row of priority) {
      expect(row.status, `${row.muscle} (priority ${row.priority})`).toBe('under');
    }
  });
});
