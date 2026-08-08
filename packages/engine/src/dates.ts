/** Calendar-date helpers. UTC-only so no timezone can shift a day boundary. */
import type { IsoDate } from './types.js';

const MS_PER_DAY = 86_400_000;

export function toEpochDay(date: IsoDate): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY);
}

export function fromEpochDay(day: number): IsoDate {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10) as IsoDate;
}

export function daysBetween(a: IsoDate, b: IsoDate): number {
  return toEpochDay(b) - toEpochDay(a);
}

export function addDays(date: IsoDate, n: number): IsoDate {
  return fromEpochDay(toEpochDay(date) + n);
}

/** Inclusive list of every calendar date from `from` to `to`. */
export function dateRange(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = toEpochDay(from); d <= toEpochDay(to); d++) out.push(fromEpochDay(d));
  return out;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
