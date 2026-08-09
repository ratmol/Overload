/**
 * Reads and writes for the calorie side, plus the one place that assembles
 * everything `adjustTarget` needs.
 *
 * The engine decides; this file only fetches. If a rule looks like it is being
 * made here, it is in the wrong file.
 */
import {
  adjustTarget,
  computeTrend,
  daysBetween,
  estimateTdee,
  reconcileIntake,
  summariseTaggedIntake,
  type ActivityTag,
  type AdjustDecision,
  type IntakeEntry,
  type IsoDate,
  type TdeeEstimate,
  type TrendPoint,
  type UserProfile,
} from '@overload/engine';
import { db, newId, type TargetState } from './db.js';

export const PROFILE_ID = 'me';

export async function getProfile(): Promise<UserProfile | undefined> {
  return db.profile.get(PROFILE_ID);
}

export async function saveProfile(profile: Omit<UserProfile, 'id'>): Promise<void> {
  await db.profile.put({ ...profile, id: PROFILE_ID });
}

export async function getTarget(): Promise<TargetState | undefined> {
  return db.target.get('current');
}

/**
 * Sets the target by hand.
 *
 * Doing this resets the baseline, because the baseline exists to measure how
 * far the ENGINE has walked the number. A manual change is a new starting
 * point, not drift, and counting it as drift would push the engine toward its
 * "this is not a calorie problem" escalation for something the user chose.
 */
export async function setTargetManually(kcal: number): Promise<void> {
  await db.target.put({
    id: 'current',
    currentKcal: kcal,
    baselineKcal: kcal,
    lastAdjustmentDate: null,
    consecutiveUnresponsive: 0,
  });
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

export async function addIntakeEntries(entries: readonly Omit<IntakeEntry, 'id'>[]): Promise<void> {
  await db.intake.bulkAdd(entries.map((e) => ({ ...e, id: newId() })));
}

/**
 * Replaces every entry on the dates the import covers.
 *
 * Re-importing an overlapping export is the normal case — you export the last
 * 90 days every time — and appending would double every day in the overlap,
 * which doubles mean intake and moves the estimated expenditure by a thousand
 * calories. Replacing per-date is the only version that is safe to run twice.
 */
export async function replaceIntakeForDates(
  dates: readonly string[],
  entries: readonly Omit<IntakeEntry, 'id'>[],
): Promise<{ replaced: number; added: number }> {
  const dateSet = new Set(dates);
  let replaced = 0;
  await db.transaction('rw', db.intake, async () => {
    const existing = await db.intake.where('date').anyOf([...dateSet]).primaryKeys();
    replaced = existing.length;
    await db.intake.bulkDelete(existing);
    await db.intake.bulkAdd(entries.map((e) => ({ ...e, id: newId() })));
  });
  return { replaced, added: entries.length };
}

/** Sets the activity tag on every entry for one day. */
export async function tagDay(date: IsoDate, tag: ActivityTag): Promise<void> {
  const ids = await db.intake.where('date').equals(date).primaryKeys();
  await db.transaction('rw', db.intake, async () => {
    for (const id of ids) await db.intake.update(id, { activityTag: tag });
  });
}

export async function logIntakeManually(input: {
  date: IsoDate;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  activityTag: ActivityTag;
}): Promise<void> {
  // A manual entry for a day replaces that day outright. Manual logging is
  // "here is my day", not "here is one more food".
  const existing = await db.intake.where('date').equals(input.date).primaryKeys();
  await db.transaction('rw', db.intake, async () => {
    await db.intake.bulkDelete(existing);
    await db.intake.add({ ...input, id: newId(), source: 'manual' });
  });
}

// ---------------------------------------------------------------------------
// The assembled view
// ---------------------------------------------------------------------------

export interface NutritionState {
  profile: UserProfile | undefined;
  target: TargetState | undefined;
  trend: TrendPoint[];
  intake: IntakeEntry[];
  estimate: TdeeEstimate | null;
  decision: AdjustDecision | null;
  tagged: ReturnType<typeof summariseTaggedIntake>;
  /**
   * Food-logged days whose shift/off tag had to be assumed. Excluded from the
   * tagged comparison, counted normally everywhere else.
   */
  untaggedDates: IsoDate[];
  /** Latest weight reading, raw, for display next to the trend. */
  latestRaw: { date: IsoDate; weightLb: number } | null;
}

export async function loadNutritionState(today: IsoDate): Promise<NutritionState> {
  const [profile, target, weights, intakeRows, foodLog, sessions] = await Promise.all([
    getProfile(),
    getTarget(),
    db.weights.orderBy('date').toArray(),
    db.intake.orderBy('date').toArray(),
    db.foodLog.orderBy('date').toArray(),
    db.sessions.orderBy('date').toArray(),
  ]);

  const trend = computeTrend(weights);
  const last = weights[weights.length - 1];

  // The single reconciled view. Nothing below this line knows there are two
  // tables, and nothing is ever handed both concatenated — that would
  // double-count every day recorded in both.
  const { entries: intake, untaggedDates } = reconcileIntake(intakeRows, foodLog);

  const estimate =
    profile === undefined
      ? null
      : estimateTdee({ today, trend, intake, goalType: profile.goalType });

  // Days with an assumed tag are dropped here specifically. The tag does not
  // affect a calorie total, so they count toward the estimate; the shift/off
  // comparison is entirely about the tag, so including a guess would be
  // fabricating the exact thing being measured.
  const untagged = new Set(untaggedDates);
  const tagged = summariseTaggedIntake(
    intake.filter((e) => !untagged.has(e.date)),
    today,
  );

  let decision: AdjustDecision | null = null;
  if (profile && target && estimate) {
    // A deload week freezes calories, and the three days after it are still
    // water weight. Both come out of the training log, not a separate setting.
    const deloads = sessions.filter((s) => s.isDeload);
    const lastDeload = deloads[deloads.length - 1];
    const inDeloadWeek = deloads.some((s) => {
      const age = daysBetween(s.date, today);
      return age >= 0 && age < 7;
    });

    decision = adjustTarget({
      today,
      profile,
      currentTarget: target.currentKcal,
      baselineTarget: target.baselineKcal,
      estimate,
      inDeloadWeek,
      ...(target.lastAdjustmentDate ? { lastAdjustmentDate: target.lastAdjustmentDate } : {}),
      ...(lastDeload ? { lastDeloadEndDate: lastDeload.date } : {}),
      consecutiveUnresponsiveAdjustments: target.consecutiveUnresponsive,
    });
  }

  return {
    profile,
    target,
    trend,
    intake,
    estimate,
    decision,
    tagged,
    untaggedDates,
    latestRaw: last ? { date: last.date, weightLb: last.weightLb } : null,
  };
}

/**
 * Writes an accepted proposal.
 *
 * Accepting is a deliberate act, not something that happens while you sleep.
 * The engine's whole claim is that it explains itself before it changes
 * anything, and a change applied silently cannot have been read first.
 */
export async function acceptAdjustment(
  today: IsoDate,
  decision: AdjustDecision,
): Promise<void> {
  if (!decision.changed) return;
  const target = await getTarget();
  if (!target) return;

  const previous = await db.adjustments.orderBy('date').last();
  const sameDirection =
    previous !== undefined &&
    Math.sign(decision.newTarget - decision.previousTarget) ===
      Math.sign(previous.newTarget - previous.previousTarget);

  await db.transaction('rw', db.adjustments, db.target, async () => {
    await db.adjustments.add({
      id: newId(),
      date: today,
      previousTarget: decision.previousTarget,
      newTarget: decision.newTarget,
      reason: decision.reason,
      confidence: decision.confidence,
    });
    await db.target.put({
      ...target,
      currentKcal: decision.newTarget,
      lastAdjustmentDate: today,
      // Counts pushes in the same direction that the trend has not answered.
      // Three of those plus 300 kcal of drift is what makes the engine stop and
      // point at a blood panel instead of adding another 100.
      consecutiveUnresponsive: sameDirection ? target.consecutiveUnresponsive + 1 : 1,
    });
  });
}
