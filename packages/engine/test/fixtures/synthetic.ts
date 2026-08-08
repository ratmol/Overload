/**
 * Synthetic datasets for the awkward cases named in the spec:
 * missing days, a sick week, a vacation, a whoosh, a scale change.
 *
 * Deterministic PRNG so a failing test is reproducible. Never Math.random().
 */
import { addDays } from '../../src/dates.js';
import type { ActivityTag, IntakeEntry, IsoDate, WeightEntry } from '../../src/types.js';

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export interface ScenarioOptions {
  start: IsoDate;
  days: number;
  startWeightLb: number;
  /** True underlying rate. */
  lbPerWeek: number;
  /** Daily scale noise, sd in lb. Real scales run ~0.6-1.0. */
  noiseSd?: number;
  /** Days (0-indexed) with no weigh-in. */
  missingDays?: number[];
  /** Inclusive day range with a large transient water gain (sick / vacation). */
  waterBump?: { from: number; to: number; lb: number };
  /** Day index where the trend drops abruptly (a "whoosh"). */
  whooshDay?: number;
  whooshLb?: number;
  /** Day index from which every reading shifts by a constant (new scale). */
  scaleChangeDay?: number;
  scaleChangeLb?: number;
  seed?: number;
}

export function makeWeights(o: ScenarioOptions): WeightEntry[] {
  const r = rng(o.seed ?? 42);
  const missing = new Set(o.missingDays ?? []);
  const noise = o.noiseSd ?? 0.7;
  const out: WeightEntry[] = [];

  for (let i = 0; i < o.days; i++) {
    if (missing.has(i)) continue;
    let w = o.startWeightLb + (o.lbPerWeek / 7) * i;

    if (o.waterBump && i >= o.waterBump.from && i <= o.waterBump.to) w += o.waterBump.lb;
    if (o.whooshDay !== undefined && i >= o.whooshDay) w += o.whooshLb ?? -2;
    if (o.scaleChangeDay !== undefined && i >= o.scaleChangeDay) w += o.scaleChangeLb ?? 1.5;

    // Box-Muller, so the noise is actually gaussian rather than uniform.
    const u1 = Math.max(r(), 1e-9);
    const u2 = r();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

    out.push({
      id: `w${i}`,
      date: addDays(o.start, i),
      weightLb: round2(w + g * noise),
      source: 'manual',
      flaggedOutlier: false,
    });
  }
  return out;
}

export interface IntakeOptions {
  start: IsoDate;
  days: number;
  meanKcal: number;
  sdKcal?: number;
  missingDays?: number[];
  /** Extra kcal on days tagged 'shift'. */
  shiftBonusKcal?: number;
  /** Day indices tagged 'shift'. Default: Mon-Fri pattern (i % 7 < 5). */
  shiftDays?: (i: number) => boolean;
  seed?: number;
}

export function makeIntake(o: IntakeOptions): IntakeEntry[] {
  const r = rng(o.seed ?? 7);
  const missing = new Set(o.missingDays ?? []);
  const sd = o.sdKcal ?? 200;
  const isShift = o.shiftDays ?? ((i: number) => i % 7 < 5);
  const out: IntakeEntry[] = [];

  for (let i = 0; i < o.days; i++) {
    if (missing.has(i)) continue;
    const tag: ActivityTag = isShift(i) ? 'shift' : 'off';
    const u1 = Math.max(r(), 1e-9);
    const u2 = r();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const kcal = Math.round(o.meanKcal + (tag === 'shift' ? (o.shiftBonusKcal ?? 0) : 0) + g * sd);

    out.push({
      id: `i${i}`,
      date: addDays(o.start, i),
      calories: Math.max(0, kcal),
      proteinG: 130,
      carbsG: 340,
      fatG: 75,
      source: 'manual',
      activityTag: tag,
    });
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
