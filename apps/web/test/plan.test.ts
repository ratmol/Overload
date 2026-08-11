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
  it('parses against the engine schema', () => {
    // The FILE version counts migrations, not program revisions — v3 is v2's
    // program plus the alternates. It only has to move when stored rows need
    // rewriting, which is what seedIfNeeded keys off.
    expect(plan.version).toBe(3);
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

  it('offers alternates for every lift the program schedules', () => {
    // "The rack is taken" and "I do not fancy this today" are the two commonest
    // reasons a session goes badly, and a slot with no alternate is a slot that
    // gets skipped rather than swapped.
    for (const id of new Set(plan.templates.flatMap((t) => t.exerciseIds))) {
      const alternates = byId.get(id)!.alternates ?? [];
      expect(alternates.length, `${id} has no alternates`).toBeGreaterThan(0);
    }
  });

  it('points every alternate at an exercise that exists, and never at itself', () => {
    // A dangling id is invisible until the moment you are standing in a busy
    // gym trying to swap out of a lift.
    for (const exercise of plan.exercises) {
      for (const alternateId of exercise.alternates ?? []) {
        expect(byId.has(alternateId), `${exercise.id} -> missing ${alternateId}`).toBe(true);
        expect(alternateId, `${exercise.id} lists itself`).not.toBe(exercise.id);
      }
    }
  });

  it('gives every alternate the fields the session screen needs', () => {
    // A swapped-in lift renders through exactly the same code path, so a
    // missing ladder or rest interval breaks the screen only once you swap.
    const alternateIds = new Set(plan.exercises.flatMap((e) => e.alternates ?? []));
    for (const id of alternateIds) {
      const e = byId.get(id)!;
      expect(e.targetRirBySet, `${id} has no RIR ladder`).toBeDefined();
      expect(e.restSeconds, `${id} has no rest interval`).toBeDefined();
      expect(e.muscles.length, `${id} has no muscles`).toBeGreaterThan(0);
    }
  });

  it('keeps a unilateral alternate for the lifts most likely to be occupied', () => {
    // Asked for by name: leg press, leg raises, rows.
    const unilateral = (id: string, wanted: string) =>
      expect(byId.get(id)!.alternates ?? [], `${id}`).toContain(wanted);
    unilateral('leg-press', 'single-leg-leg-press');
    unilateral('leg-extension', 'single-leg-leg-extension');
    unilateral('hanging-leg-raise', 'lying-leg-raise');
    unilateral('chest-supported-row', 'single-arm-db-row');
    unilateral('seated-cable-row', 'single-arm-cable-row');
    unilateral('romanian-deadlift', 'single-leg-rdl');
  });

  it('keeps a unilateral swap worth the same volume as the lift it replaces', () => {
    // A single-leg press is one set, not two: both legs are worked inside the
    // set. If it counted double, swapping in a variant on a busy day would
    // report a volume increase for doing the same work.
    const bilateral = byId.get('leg-press')!;
    const single = byId.get('single-leg-leg-press')!;
    expect(single.defaultSets).toBe(bilateral.defaultSets);
    const quads = (e: typeof single) =>
      e.muscles.find((m) => m.muscle === 'quads')!.fraction;
    expect(quads(single)).toBe(quads(bilateral));
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
