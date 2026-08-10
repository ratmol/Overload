/**
 * Pins the program's own claims about itself.
 *
 * `PROGRAM-V2.md` publishes a weekly volume table and a 75-sets-a-week figure.
 * Those are claims about `plan.json`, and `plan.json` is 700 lines of
 * hand-transcribed data where a wrong `defaultSets` is invisible to review and
 * silently changes what the program is. This computes the real numbers with the
 * engine's own counting rules and asserts them.
 *
 * Where these disagree with the document, the disagreement is written down
 * rather than rounded away — see the two cases below.
 */
import { describe, expect, it } from 'vitest';
import { Plan, auditVolume, type MuscleGroup, type SetLog } from '@overload/engine';
import planJson from '../../../data/plan.json';

const plan = Plan.parse(planJson);
const byId = new Map(plan.exercises.map((e) => [e.id, e]));

/** One perfect week: every prescribed set of every template, at RIR 1. */
function weeklyVolume() {
  const sets: SetLog[] = [];
  const sessionDates = new Map<string, string>();
  plan.templates.forEach((template, t) => {
    const date = `2026-08-0${t + 3}`;
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
          rir: 1,
          timestamp: `${date}T10:0${i}:00.000Z`,
          isWarmup: false,
        });
      }
    });
  });

  const rows = auditVolume({
    today: '2026-08-09',
    windowDays: 7,
    sets,
    sessionDates,
    exercises: plan.exercises,
    targets: plan.volumeTargets,
  });
  return { rows, totalSets: sets.length };
}

describe('plan.json is program v2', () => {
  it('is version 2 and parses against the engine schema', () => {
    expect(plan.version).toBe(2);
  });

  it('runs 75 hard sets a week, the figure the document publishes', () => {
    expect(weeklyVolume().totalSets).toBe(75);
  });

  it('cuts the deadlift from every template but keeps the exercise', () => {
    // Kept so months of logged deadlift sets still resolve to a name, and so it
    // stays available as a substitute. Removing the row would orphan history.
    const scheduled = new Set(plan.templates.flatMap((t) => t.exerciseIds));
    expect(scheduled.has('deadlift')).toBe(false);
    expect(byId.has('deadlift')).toBe(true);
  });

  it('replaces flat bench with incline barbell press', () => {
    const scheduled = new Set(plan.templates.flatMap((t) => t.exerciseIds));
    expect(scheduled.has('barbell-bench-press')).toBe(false);
    expect(scheduled.has('incline-barbell-press')).toBe(true);
    expect(byId.get('incline-barbell-press')!.incrementLb).toBe(2.5);
  });

  it('gives every scheduled exercise an RIR ladder and a rest interval', () => {
    // The ladder is the redesign. An exercise without one silently falls back
    // to RIR 2, which is wrong in both directions: too hard for a systemic
    // compound's early sets, too easy for a lateral raise.
    for (const id of new Set(plan.templates.flatMap((t) => t.exerciseIds))) {
      const e = byId.get(id)!;
      expect(e.targetRirBySet, `${id} has no RIR ladder`).toBeDefined();
      expect(e.restSeconds, `${id} has no rest interval`).toBeDefined();
    }
  });

  it('reserves true failure for exercises that fail locally', () => {
    // "Failure is earned by the exercise, not by me." Nothing loaded by a belt,
    // a barbell, or both hands on dumbbells may reach RIR 0.
    const systemic = ['weighted-pullup', 'weighted-dip', 'back-squat', 'incline-barbell-press', 'incline-db-press', 'romanian-deadlift', 'bulgarian-split-squat'];
    for (const id of systemic) {
      const ladder = byId.get(id)!.targetRirBySet!;
      expect(Math.min(...ladder), `${id} reaches failure`).toBeGreaterThanOrEqual(1);
    }
    // And the lateral raise, the priority-1 lever, is failure on every set.
    expect(byId.get('cable-lateral-raise')!.targetRirBySet).toEqual([0]);
  });

  const expected: Partial<Record<MuscleGroup, number>> = {
    sideDelts: 8,
    upperChest: 8,
    latsWidth: 6,
    rearDelts: 9.5,
    lats: 12,
    upperBack: 12.5,
    chest: 10,
    quads: 12,
    calves: 6,
    // PROGRAM-V2's table says 3 and 9. The engine counts band pull-apart's
    // lowerTraps at 0.5 and hip thrust's hamstrings at 0.5, which the
    // hand-written table did not. Both land inside target either way, so the
    // engine's number stands and the document is the one that is approximate.
    lowerTraps: 4,
    hamstrings: 10.5,
  };

  it.each(Object.entries(expected))('puts %s at %d sets a week', (muscle, sets) => {
    const row = weeklyVolume().rows.find((r) => r.muscle === muscle)!;
    expect(row.sets).toBe(sets);
  });

  it('holds or raises every priority muscle, which is the document\'s core claim', () => {
    const rows = weeklyVolume().rows;
    for (const row of rows.filter((r) => r.priority !== undefined)) {
      expect(row.status, `${row.muscle} (priority ${row.priority}) is ${row.status}`).toBe(
        'in-range',
      );
    }
  });

  it('leaves direct arm work below target, which the document does not mention', () => {
    // Not a transcription error — a real consequence of v2. v1 carried an
    // incline DB curl and a flat bench; v2 has neither, and dips dropped to two
    // sets. Arms are now entirely secondary volume off pulls and presses.
    //
    // Asserted rather than fixed, because inventing exercises the program does
    // not list would hide it. The volume screen will show these red every week
    // until either the program or the targets change, and that is the audit
    // working.
    const rows = weeklyVolume().rows;
    expect(rows.find((r) => r.muscle === 'biceps')!.sets).toBe(4.5);
    expect(rows.find((r) => r.muscle === 'biceps')!.status).toBe('under');
    expect(rows.find((r) => r.muscle === 'triceps')!.sets).toBe(5);
    expect(rows.find((r) => r.muscle === 'triceps')!.status).toBe('under');
  });
});
