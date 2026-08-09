import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ADJUST_OPTIONS,
  DEFAULT_TDEE_OPTIONS,
  trendWarmupDays,
  type IntakeEntry,
  type TrendPoint,
} from '@overload/engine';
import { computeReadiness } from '../src/lib/readiness.js';

const TODAY = '2026-09-01';

function day(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** A contiguous daily trend series ending today, all readings real. */
function trend(days: number, opts: { gapAtEnd?: number } = {}): TrendPoint[] {
  const gap = opts.gapAtEnd ?? 0;
  return Array.from({ length: days }, (_, i) => {
    const date = day(TODAY, -(days - 1 - i) - gap);
    return { date, raw: 132 + i * 0.05, trend: 132 + i * 0.05, flaggedOutlier: false };
  });
}

function intake(days: number): IntakeEntry[] {
  return Array.from({ length: days }, (_, i) => ({
    id: `i${i}`,
    date: day(TODAY, -i),
    calories: 2600,
    proteinG: 150,
    carbsG: 260,
    fatG: 80,
    source: 'manual' as const,
    activityTag: 'off' as const,
  }));
}

const get = (r: ReturnType<typeof computeReadiness>, id: string) =>
  r.requirements.find((x) => x.id === id)!;

describe('computeReadiness', () => {
  it('reports nothing met on a genuinely empty database', () => {
    const r = computeReadiness(TODAY, [], []);
    expect(r.ready).toBe(false);
    expect(r.requirements.every((x) => !x.met)).toBe(true);
    expect(r.nextAction).toContain('no weight data at all');
  });

  it('is fully ready once every threshold is cleared', () => {
    const r = computeReadiness(TODAY, trend(trendWarmupDays()), intake(28));
    expect(r.ready).toBe(true);
    expect(r.nextAction).toBeNull();
  });

  it('takes its thresholds from the engine rather than hardcoding them', () => {
    // The point of the test: if someone retunes a guardrail, this screen moves
    // with it. A progress screen promising a threshold the engine no longer
    // uses is worse than no screen.
    const r = computeReadiness(TODAY, [], []);
    expect(get(r, 'weight-span').need).toBe(trendWarmupDays());
    expect(get(r, 'intake-days').need).toBe(DEFAULT_ADJUST_OPTIONS.minLoggedDays);
    expect(get(r, 'intake-coverage').need).toBe(
      Math.ceil(DEFAULT_ADJUST_OPTIONS.minCoverage * DEFAULT_TDEE_OPTIONS.windowDays),
    );
    expect(get(r, 'freshness').need).toBe(DEFAULT_TDEE_OPTIONS.maxWeighInStalenessDays);
  });

  it('separates calendar span from reading count', () => {
    // Two readings sixty days apart: computeTrend carries the trend forward, so
    // the series is long while almost nothing real is behind it. isWarmingUp
    // checks both, so this screen has to as well.
    const sparse: TrendPoint[] = trend(60).map((p, i) =>
      i === 0 || i === 59 ? p : { ...p, raw: null },
    );
    const r = computeReadiness(TODAY, sparse, []);
    expect(get(r, 'weight-span').met).toBe(true);
    expect(get(r, 'weight-count').met).toBe(false);
    expect(get(r, 'weight-count').have).toBe(2);
  });

  it('counts only intake inside the estimator window', () => {
    const old: IntakeEntry[] = [
      { ...intake(1)[0]!, id: 'old', date: day(TODAY, -40) },
      ...intake(5),
    ];
    expect(get(computeReadiness(TODAY, [], old), 'intake-days').have).toBe(5);
  });

  it('counts distinct days, not rows, so a per-food log is not inflated', () => {
    // Cronometer exports one row per food. Twelve rows on one day is one day of
    // coverage, and counting rows would report 12/28 for a single breakfast.
    const manyRows: IntakeEntry[] = Array.from({ length: 12 }, (_, i) => ({
      ...intake(1)[0]!,
      id: `r${i}`,
      date: TODAY,
      calories: 200,
    }));
    expect(get(computeReadiness(TODAY, [], manyRows), 'intake-days').have).toBe(1);
  });

  it('flags staleness and makes weighing in the next action', () => {
    const stale = trend(30, { gapAtEnd: 6 });
    const r = computeReadiness(TODAY, stale, intake(28));
    expect(get(r, 'freshness').met).toBe(false);
    expect(get(r, 'freshness').have).toBe(6);
    expect(r.nextAction).toContain('Weigh in');
  });

  it('prioritises intake over waiting when weight data is current', () => {
    const r = computeReadiness(TODAY, trend(trendWarmupDays()), intake(3));
    expect(get(r, 'freshness').met).toBe(true);
    expect(r.nextAction).toContain('Log what you ate');
  });
});
