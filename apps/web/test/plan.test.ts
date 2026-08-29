/**
 * Pins the program's own claims about itself.
 *
 * `plan.json` is program v6 — a four-day Push / Pull / Legs / Shoulders-Arms-Abs
 * split, failure training with the big compounds mixed back in. Every exercise
 * is TWO work sets: isolation to true failure (RIR 0), and the systemic
 * compounds (squat, RDL, weighted pull-up, weighted dip) stopped at
 * form-failure (RIR 1) — a coached carve-out, since you fail a squat by getting
 * pinned under it. Front delts are the priority: a dedicated DB shoulder press
 * on both Push and Day 4. Deload is handled entirely by the engine
 * (`deloadPrescription` forces RIR 4 and halves the sets), so "not to failure
 * on a deload" needs nothing in the data.
 */
import { describe, expect, it } from 'vitest';
import { Plan, auditVolume, type MuscleGroup, type SetLog } from '@overload/engine';
import planJson from '../../../data/plan.json';

const plan = Plan.parse(planJson);
const byId = new Map(plan.exercises.map((e) => [e.id, e]));
const scheduledIds = () => new Set(plan.templates.flatMap((t) => t.exerciseIds));

/** The systemic lifts capped at form-failure (RIR 1). Everything else is RIR 0. */
const COMPOUNDS = new Set(['weighted-dip', 'weighted-pullup', 'back-squat', 'romanian-deadlift']);

/** One full week: every template once, dated so a 7-day sweep catches all four. */
function perWeekVolume() {
  const sets: SetLog[] = [];
  const sessionDates = new Map<string, string>();
  const dayOffsets: Record<string, number> = {
    'day-1-push': 1,
    'day-2-pull': 2,
    'day-3-legs': 4,
    'day-4-sa': 5,
  };

  plan.templates.forEach((template) => {
    const day = dayOffsets[template.id] ?? 1;
    const date = `2026-08-0${day}`;
    sessionDates.set(template.id, date);
    template.exerciseIds.forEach((exerciseId) => {
      const exercise = byId.get(exerciseId)!;
      for (let i = 0; i < exercise.defaultSets; i++) {
        sets.push({
          id: `${template.id}-${exerciseId}-${i}`,
          sessionId: template.id,
          exerciseId,
          addedWeightLb: exercise.startingLoadLb ?? 50,
          reps: exercise.defaultRepRange[0],
          rir: 0,
          timestamp: `${date}T10:0${i}:00.000Z`,
          isWarmup: false,
        });
      }
    });
  });

  const rows = auditVolume({
    today: '2026-08-07',
    windowDays: 7,
    sets,
    sessionDates,
    exercises: plan.exercises,
    targets: plan.volumeTargets,
  });
  const statusOf = (m: MuscleGroup) => rows.find((r) => r.muscle === m)!.status;
  return { rows, statusOf, totalSets: sets.length };
}

describe('plan.json is the PPL split (program v6)', () => {
  it('parses against the engine schema, at file version 6', () => {
    expect(plan.version).toBe(6);
  });

  it('keeps the calendar deload — a fixed weekly split, no session counter', () => {
    expect(plan.deloadEverySessions).toBeUndefined();
    expect(plan.deloadEveryWeeks).toBe(6);
  });

  it('is Push, Pull, Legs, then Shoulders/Arms/Abs', () => {
    expect(plan.templates.map((t) => t.id)).toEqual([
      'day-1-push',
      'day-2-pull',
      'day-3-legs',
      'day-4-sa',
    ]);
  });

  it('prescribes exactly two work sets on every scheduled exercise', () => {
    // "Make every exercise 2 sets." A stray 1 or 3 silently changes the dose.
    for (const id of scheduledIds()) {
      expect(byId.get(id)!.defaultSets, `${id} is not two sets`).toBe(2);
    }
  });

  it('caps the systemic compounds at form-failure and fails everything else', () => {
    // The coached split: isolation to true failure (RIR 0), but squat, RDL and
    // the weighted body-weight lifts stop the rep form breaks (RIR 1). Deload
    // overrides all of this to RIR 4 in the engine — see deloadPrescription.
    for (const id of scheduledIds()) {
      const expected = COMPOUNDS.has(id) ? [1] : [0];
      expect(byId.get(id)!.targetRirBySet, `${id} RIR`).toEqual(expected);
    }
  });

  it('brings the big compounds back — a dip, a pull-up and a squat', () => {
    // The whole point of the revision: the 1x4 Method was isolation-only, this
    // one is built on the compounds again.
    expect(scheduledIds().has('weighted-dip')).toBe(true);
    expect(scheduledIds().has('weighted-pullup')).toBe(true);
    expect(scheduledIds().has('back-squat')).toBe(true);
  });

  it('runs straight sets — no scheduled exercise carries a superset group', () => {
    for (const id of scheduledIds()) {
      expect(byId.get(id)!.supersetGroup, `${id} still has a superset group`).toBeUndefined();
    }
  });

  it('prioritises front delts: a dedicated press on both Push and Day 4', () => {
    // "I lack front-delt definition, prioritise that." A DB shoulder press with
    // front delts as the primary mover, twice a week, plus a priority target.
    const press = byId.get('db-shoulder-press')!;
    expect(press.muscles[0]!.muscle).toBe('frontDelts');
    expect(press.muscles[0]!.fraction).toBe(1);
    const push = plan.templates.find((t) => t.id === 'day-1-push')!.exerciseIds;
    const day4 = plan.templates.find((t) => t.id === 'day-4-sa')!.exerciseIds;
    expect(push).toContain('db-shoulder-press');
    expect(day4).toContain('db-shoulder-press');
    const target = plan.volumeTargets.find((t) => t.muscle === ('frontDelts' as MuscleGroup))!;
    expect(target.priority).toBeDefined();
  });

  it('puts abs on Day 4', () => {
    expect(plan.templates.find((t) => t.id === 'day-4-sa')!.exerciseIds).toContain('cable-crunch');
  });

  it('keeps every earlier exercise so old logged sets still resolve', () => {
    for (const id of ['leg-press', 'hip-thrust', 'neck-curl', 'wrist-roller', 'pec-deck']) {
      expect(byId.has(id), `${id} was orphaned`).toBe(true);
    }
  });

  it('gives every scheduled exercise the fields the session screen needs', () => {
    for (const id of scheduledIds()) {
      const e = byId.get(id)!;
      expect(e.restSeconds, `${id} has no rest interval`).toBeDefined();
      expect(e.muscles.length, `${id} has no muscles`).toBeGreaterThan(0);
    }
  });

  it('points every alternate at an exercise that exists, and never at itself', () => {
    for (const exercise of plan.exercises) {
      for (const alternateId of exercise.alternates ?? []) {
        expect(byId.has(alternateId), `${exercise.id} -> missing ${alternateId}`).toBe(true);
        expect(alternateId, `${exercise.id} lists itself`).not.toBe(exercise.id);
      }
    }
  });

  // ------------------------------------------------------------------------
  // Delivered volume against the user's own targets. v6 is a real hypertrophy
  // dose (40 work sets a week), so the priorities the split actually trains
  // land in range — and the ones it doesn't are pinned as honest gaps, not
  // smoothed over.
  // ------------------------------------------------------------------------

  it('logs 40 work sets across the four-day week', () => {
    // 2 sets x (5 + 4 + 5 + 6) lifts. A real dose again after the 1x4 Method's 16.
    expect(perWeekVolume().totalSets).toBe(40);
  });

  it('hits the shoulder priorities — front and side delts both in range', () => {
    const { statusOf } = perWeekVolume();
    expect(statusOf('frontDelts' as MuscleGroup)).toBe('in-range');
    expect(statusOf('sideDelts' as MuscleGroup)).toBe('in-range');
  });

  it('REGRESSION: upper chest and lat width stay under — the split does not train them directly', () => {
    // Chest thickness/upper-chest (only the incline press feeds it) and lat
    // width (only the wide pulldown) each get ~2 sets against a 6-set floor.
    // These were priorities under the old program; the PPL structure the user
    // asked for does not carry dedicated work for them. Called out, not fixed
    // behind their back — adding a lift is a program decision.
    const { statusOf } = perWeekVolume();
    expect(statusOf('upperChest' as MuscleGroup)).toBe('under');
    expect(statusOf('latsWidth' as MuscleGroup)).toBe('under');
  });
});
