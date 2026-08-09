import type { IsoDate } from '@overload/engine';

/**
 * Weights print without trailing zeros: 52.5, not 52.50, and 50, not 50.0.
 * A column of numbers is easier to scan when nothing is padding.
 */
export function lb(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** The system-load em dash. Never a zero, never a guess. */
export const UNKNOWN = '—';

export function formatSystemLoad(value: number | null): string {
  return value === null ? UNKNOWN : lb(value);
}

export function longDate(date: IsoDate): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

export function shortDate(date: IsoDate): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function daysAgo(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

export function clock(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  const sign = seconds < 0 ? '+' : '';
  return `${sign}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "4 × 8 @ 50 lb" — the way it would be written in a paper log. */
export function describeSets(
  sets: readonly { addedWeightLb: number; reps: number }[],
): string {
  if (sets.length === 0) return UNKNOWN;
  const loads = new Set(sets.map((s) => s.addedWeightLb));
  const reps = sets.map((s) => s.reps);
  if (loads.size === 1) {
    const load = lb(sets[0]!.addedWeightLb);
    const allSame = new Set(reps).size === 1;
    return allSame
      ? `${sets.length} × ${reps[0]} @ ${load} lb`
      : `${reps.join('/')} @ ${load} lb`;
  }
  return sets.map((s) => `${s.reps}@${lb(s.addedWeightLb)}`).join('  ');
}
