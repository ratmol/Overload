/**
 * What the engine has, what it still needs, and what each threshold unlocks.
 *
 * Without this the first month reads as a broken app. Every figure on the Body
 * screen is an em dash, the engine refuses to act, and nothing says whether
 * that is because something is wrong or because it is Tuesday of week one. The
 * engine was behaving correctly and the product was failing.
 *
 * Every threshold here is READ FROM THE ENGINE, never retyped. A screen that
 * promises "14 days unlocks an estimate" while `adjust.ts` wants 16 is worse
 * than no screen at all, and hand-copied constants are how that happens.
 */
import {
  DEFAULT_ADJUST_OPTIONS,
  DEFAULT_TDEE_OPTIONS,
  daysBetween,
  trendWarmupDays,
  type IntakeEntry,
  type IsoDate,
  type TrendPoint,
} from '@overload/engine';

export interface Requirement {
  id: string;
  label: string;
  have: number;
  need: number;
  met: boolean;
  /** Plain English: what starts working when this one is satisfied. */
  unlocks: string;
  /** True for staleness, where a smaller number is the good one. */
  lowerIsBetter?: boolean;
}

export interface Readiness {
  requirements: Requirement[];
  /** True once every requirement is met and the engine may propose changes. */
  ready: boolean;
  /** The single most useful thing to do next, or null when ready. */
  nextAction: string | null;
}

export function computeReadiness(
  today: IsoDate,
  trend: readonly TrendPoint[],
  intake: readonly IntakeEntry[],
): Readiness {
  const windowDays = DEFAULT_TDEE_OPTIONS.windowDays;
  const inWindow = (date: IsoDate) => {
    const age = daysBetween(date, today);
    return age >= 0 && age < windowDays;
  };

  const realReadings = trend.filter((p) => p.raw !== null);
  const weighInsInWindow = realReadings.filter((p) => inWindow(p.date)).length;
  const lastWeighIn = realReadings[realReadings.length - 1];
  const staleness = lastWeighIn ? daysBetween(lastWeighIn.date, today) : Infinity;

  const intakeDays = new Set(intake.filter((e) => inWindow(e.date)).map((e) => e.date)).size;

  // isWarmingUp() gates on BOTH calendar span and reading count, so both are
  // shown. Two readings 60 days apart produce a 61-day series and no knowledge.
  const warmupDays = trendWarmupDays();
  const warmupReadings = Math.ceil(warmupDays / 2);

  const requirements: Requirement[] = [
    {
      id: 'weight-span',
      label: 'Days of weight history',
      have: trend.length,
      need: warmupDays,
      met: trend.length >= warmupDays,
      unlocks:
        'The trend filter settles. Until then it reads your rate of gain as slower than it is, which looks like "not gaining" and invites adding food you do not need.',
    },
    {
      id: 'weight-count',
      label: 'Weigh-ins logged',
      have: realReadings.length,
      need: warmupReadings,
      met: realReadings.length >= warmupReadings,
      unlocks:
        'Enough real readings behind that history for the slope to mean something. Two readings sixty days apart make a long series and no knowledge.',
    },
    {
      id: 'intake-days',
      label: `Days of intake in the last ${windowDays}`,
      have: intakeDays,
      need: DEFAULT_ADJUST_OPTIONS.minLoggedDays,
      met: intakeDays >= DEFAULT_ADJUST_OPTIONS.minLoggedDays,
      unlocks: 'An expenditure estimate above low confidence.',
    },
    {
      id: 'intake-coverage',
      label: `Intake coverage of the last ${windowDays}`,
      have: intakeDays,
      need: Math.ceil(DEFAULT_ADJUST_OPTIONS.minCoverage * windowDays),
      met: intakeDays / windowDays >= DEFAULT_ADJUST_OPTIONS.minCoverage,
      unlocks:
        'Calorie changes. Below this the unlogged days are usually the big ones, which biases everything.',
    },
    {
      id: 'weighin-coverage',
      label: `Weigh-ins in the last ${windowDays}`,
      have: weighInsInWindow,
      need: Math.ceil(DEFAULT_TDEE_OPTIONS.minWeighInCoverage * windowDays),
      met: weighInsInWindow / windowDays >= DEFAULT_TDEE_OPTIONS.minWeighInCoverage,
      unlocks:
        'A trend that is mostly real readings rather than carried-forward ones. Weekly weigh-ins alone read about 38% low.',
    },
    {
      id: 'freshness',
      label: 'Days since last weigh-in',
      have: Number.isFinite(staleness) ? staleness : 0,
      need: DEFAULT_TDEE_OPTIONS.maxWeighInStalenessDays,
      met: staleness <= DEFAULT_TDEE_OPTIONS.maxWeighInStalenessDays,
      lowerIsBetter: true,
      unlocks:
        'The weight and intake halves of the calculation covering the same stretch of time.',
    },
  ];

  const unmet = requirements.filter((r) => !r.met);

  return {
    requirements,
    ready: unmet.length === 0,
    nextAction: nextAction(unmet, staleness),
  };
}

/**
 * One instruction, not six. A checklist of everything outstanding is a wall;
 * the useful output is what to do today.
 */
function nextAction(unmet: readonly Requirement[], staleness: number): string | null {
  if (unmet.length === 0) return null;
  if (unmet.some((r) => r.id === 'freshness')) {
    return Number.isFinite(staleness)
      ? 'Weigh in. Everything else is waiting on a current reading.'
      : 'Weigh in. There is no weight data at all yet.';
  }
  if (unmet.some((r) => r.id === 'intake-days' || r.id === 'intake-coverage')) {
    return 'Log what you ate today. Intake is the half that is furthest behind.';
  }
  return 'Keep weighing in daily. This one is only waiting on time passing.';
}
