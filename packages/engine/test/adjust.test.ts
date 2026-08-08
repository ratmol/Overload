/**
 * Guardrail tests. The spec says to write these BEFORE the feature, because a
 * calorie engine that acts on thin data is worse than no calorie engine.
 */
import { describe, expect, it } from 'vitest';
import { adjustTarget, type AdjustInputs } from '../src/adjust.js';
import type { TdeeEstimate } from '../src/tdee.js';

const estimate = (over: Partial<TdeeEstimate> = {}): TdeeEstimate => ({
  kcal: 2450,
  low: 2350,
  high: 2550,
  confidence: 'medium',
  loggedDays: 26,
  windowDays: 28,
  coverage: 26 / 28,
  slopePerDay: 0.4 / 7,
  energyDensityPerLb: 2500,
  warmingUp: false,
  reason: 'test',
  ...over,
});

const base: AdjustInputs = {
  today: '2026-09-11',
  profile: { goalType: 'gain', targetRatePerWeekLb: 0.4, caloriesLocked: false },
  currentTarget: 2550,
  estimate: estimate(),
  inDeloadWeek: false,
};

describe('guardrails', () => {
  it('blocks with fewer than 14 days in the window', () => {
    const r = adjustTarget({ ...base, estimate: estimate({ windowDays: 10, loggedDays: 10 }) });
    expect(r.changed).toBe(false);
    expect(r.blockedBy).toBe('insufficient-window');
  });

  it('blocks with fewer than 10 logged days in the window', () => {
    const r = adjustTarget({ ...base, estimate: estimate({ loggedDays: 9 }) });
    expect(r.changed).toBe(false);
    expect(r.blockedBy).toBe('insufficient-logged-days');
  });

  it('blocks a second adjustment inside 7 days', () => {
    const r = adjustTarget({ ...base, lastAdjustmentDate: '2026-09-08' });
    expect(r.blockedBy).toBe('too-soon');
  });

  it('allows an adjustment at exactly 7 days', () => {
    const r = adjustTarget({
      ...base,
      lastAdjustmentDate: '2026-09-04',
      estimate: estimate({ slopePerDay: 0 }),
    });
    expect(r.blockedBy).not.toBe('too-soon');
  });

  it('blocks during a deload week', () => {
    const r = adjustTarget({ ...base, inDeloadWeek: true });
    expect(r.blockedBy).toBe('deload-cooldown');
    expect(r.reason.toLowerCase()).toContain('deload');
  });

  it('blocks within 3 days after a deload week', () => {
    const r = adjustTarget({ ...base, lastDeloadEndDate: '2026-09-09' });
    expect(r.blockedBy).toBe('deload-cooldown');
  });

  it('allows an adjustment 3 days after a deload', () => {
    const r = adjustTarget({
      ...base,
      lastDeloadEndDate: '2026-09-08',
      estimate: estimate({ slopePerDay: 0 }),
    });
    expect(r.blockedBy).not.toBe('deload-cooldown');
  });

  it('blocks when calories are locked', () => {
    const r = adjustTarget({
      ...base,
      profile: { ...base.profile, caloriesLocked: true },
      estimate: estimate({ slopePerDay: 0 }),
    });
    expect(r.blockedBy).toBe('calories-locked');
  });

  it('never changes by more than 100 kcal', () => {
    // Wildly off target: losing fast while trying to gain.
    const r = adjustTarget({ ...base, estimate: estimate({ slopePerDay: -1 }) });
    expect(Math.abs(r.deltaKcal)).toBeLessThanOrEqual(100);
    expect(r.reason).toContain('capped');
  });

  it('always populates a reason, blocked or not', () => {
    const cases: AdjustInputs[] = [
      base,
      { ...base, inDeloadWeek: true },
      { ...base, estimate: estimate({ loggedDays: 2 }) },
      { ...base, estimate: estimate({ slopePerDay: -1 }) },
    ];
    for (const c of cases) expect(adjustTarget(c).reason.length).toBeGreaterThan(0);
  });
});

describe('direction and magnitude', () => {
  it('raises calories when gaining more slowly than the target', () => {
    const r = adjustTarget({ ...base, estimate: estimate({ slopePerDay: 0.1 / 7 }) });
    expect(r.changed).toBe(true);
    expect(r.deltaKcal).toBeGreaterThan(0);
    expect(r.newTarget).toBeGreaterThan(r.previousTarget);
  });

  it('lowers calories when gaining faster than the target', () => {
    const r = adjustTarget({ ...base, estimate: estimate({ slopePerDay: 1.0 / 7 }) });
    expect(r.changed).toBe(true);
    expect(r.deltaKcal).toBeLessThan(0);
  });

  it('does nothing when the trend already matches the target', () => {
    const r = adjustTarget({ ...base, estimate: estimate({ slopePerDay: 0.4 / 7 }) });
    expect(r.changed).toBe(false);
    expect(r.blockedBy).toBe('on-target');
  });

  it('ignores sub-25 kcal corrections as noise', () => {
    const r = adjustTarget({ ...base, estimate: estimate({ slopePerDay: 0.37 / 7 }) });
    expect(r.deltaKcal).toBe(0);
  });

  it('rounds every change to a 25 kcal step', () => {
    const r = adjustTarget({ ...base, estimate: estimate({ slopePerDay: 0.05 / 7 }) });
    expect(r.deltaKcal % 25).toBe(0);
  });

  it('names the energy density it used, so the number is auditable', () => {
    const r = adjustTarget({ ...base, estimate: estimate({ slopePerDay: 0.05 / 7 }) });
    expect(r.reason).toContain('2500');
    expect(r.reason).toContain('not 3500');
  });

  it('carries the confidence through to the decision', () => {
    const r = adjustTarget({ ...base, estimate: estimate({ confidence: 'low', slopePerDay: 0 }) });
    expect(r.confidence).toBe('low');
  });
});
