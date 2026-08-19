/**
 * Pins the program's own claims about itself.
 *
 * `PROGRAM-V3.md` publishes per-session set counts, a weekly volume table and
 * a "~69 sets a week" figure. Those are claims about `plan.json`, and
 * `plan.json` is 700+ lines of hand-transcribed data where a wrong
 * `defaultSets` is invisible to review and silently changes what the program
 * is. This computes the real numbers with the engine's own counting rules and
 * asserts them.
 *
 * Where these disagree with the document, the disagreement is written down
 * rather than rounded away — see the volume-regression tests near the bottom.
 */
import { describe, expect, it } from 'vitest';
import { Plan, auditVolume, type MuscleGroup, type SetLog } from '@overload/engine';
import planJson from '../../../data/plan.json';

const plan = Plan.parse(planJson);
const byId = new Map(plan.exercises.map((e) => [e.id, e]));
const scheduledIds = () => new Set(plan.templates.flatMap((t) => t.exerciseIds));

function setsFor(templateId: string): number {
  const template = plan.templates.find((t) => t.id === templateId)!;
  return template.exerciseIds.reduce((a, id) => a + byId.get(id)!.defaultSets, 0);
}

/**
 * One full 6-day rotation: every template exactly once, each dated so a
 * single `windowDays` sweep catches all four with none spilling into a second
 * cycle. This is the natural unit for a rolling program — see PROGRAM-V3.md's
 * own "per 6-day cycle, converted to a weekly rate" framing. `auditVolume`
 * still just counts real dated sets; there is no rotation-awareness in it,
 * and there does not need to be.
 */
function perCycleVolume() {
  const sets: SetLog[] = [];
  const sessionDates = new Map<string, string>();
  const dayOffsets: Record<string, number> = { 'upper-a': 1, 'lower-a': 2, 'upper-b': 4, 'lower-b': 5 };

  plan.templates.forEach((template) => {
    const day = dayOffsets[template.id] ?? 1;
    const date = `2026-08-${String(day).padStart(2, '0')}`;
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
    today: '2026-08-06',
    windowDays: 6,
    sets,
    sessionDates,
    exercises: plan.exercises,
    targets: plan.volumeTargets,
  });
  return { rows, totalSets: sets.length };
}

/** Weekly-rate conversion the document itself uses: per-cycle × 7/6. */
function weeklyRate(muscle: MuscleGroup): number {
  const row = perCycleVolume().rows.find((r) => r.muscle === muscle)!;
  return (row.sets * 7) / 6;
}

describe('plan.json is program v3', () => {
  it('parses against the engine schema, at version 4', () => {
    // The FILE version counts migrations, not program revisions. v1->v2 was
    // program v2; v2->v3 added alternates; this migration is program v3.
    expect(plan.version).toBe(4);
  });

  it('carries a session-counted deload timer, for a program with no weeks', () => {
    // "A rolling cycle is a queue, not a calendar" — a deload timer counting
    // calendar weeks would be measuring something the program itself ignores.
    expect(plan.deloadEverySessions).toBe(24);
  });

  it('matches every per-session set count the document publishes', () => {
    // PROGRAM-V3.md states these directly under each session's table: "15
    // sets", "14 sets", "16 sets", "15 sets". If a single defaultSets is
    // mistyped this is the first thing to catch it.
    expect(setsFor('upper-a')).toBe(15);
    expect(setsFor('lower-a')).toBe(14);
    expect(setsFor('upper-b')).toBe(16);
    expect(setsFor('lower-b')).toBe(15);
  });

  it('runs 60 hard sets per 6-day cycle — the "~69 sets a week" the document publishes', () => {
    // 60 x 7/6 = 70, against the document's "~69". The document rounds down
    // from the same arithmetic; this is not a discrepancy worth a finding.
    expect(perCycleVolume().totalSets).toBe(60);
  });

  it('rotation order is Upper A, Lower A, Upper B, Lower B — the day-1/2/4/5 sequence', () => {
    expect(plan.templates.map((t) => t.id)).toEqual(['upper-a', 'lower-a', 'upper-b', 'lower-b']);
  });

  it('drops weighted-dip and prone-y-raise from every template but keeps the exercises', () => {
    // Kept so past logged sets still resolve to a name, and so both remain
    // available as swap-in alternates. Removing the rows would orphan history
    // — same precedent as v2 keeping the deadlift and flat bench.
    const scheduled = scheduledIds();
    expect(scheduled.has('weighted-dip')).toBe(false);
    expect(scheduled.has('prone-y-raise')).toBe(false);
    expect(byId.has('weighted-dip')).toBe(true);
    expect(byId.has('prone-y-raise')).toBe(true);
  });

  it('clears the superset pairing on exercises dropped from the rotation', () => {
    // A stale supersetGroup on an unscheduled exercise is a latent bug: if it
    // is ever swapped back in, the partner lookup is scoped to whatever is on
    // screen and would silently pair it with an unrelated exercise that
    // happens to share the old label.
    expect(byId.get('weighted-dip')!.supersetGroup).toBeUndefined();
    expect(byId.get('prone-y-raise')!.supersetGroup).toBeUndefined();
  });

  it('moves the low-to-high cable fly from Upper B to Upper A, paired with the row', () => {
    const upperA = plan.templates.find((t) => t.id === 'upper-a')!.exerciseIds;
    const upperB = plan.templates.find((t) => t.id === 'upper-b')!.exerciseIds;
    expect(upperA).toContain('low-to-high-cable-fly');
    expect(upperB).not.toContain('low-to-high-cable-fly');
    expect(byId.get('low-to-high-cable-fly')!.supersetGroup).toBe(
      byId.get('chest-supported-row')!.supersetGroup,
    );
  });

  it('no longer supersets the reverse pec deck — it is solo in Upper B now', () => {
    // v2 paired it with the cable fly under group 'C'. The fly moved out;
    // leaving the pec deck's old label behind would be exactly the stale-group
    // bug described above.
    expect(byId.get('reverse-pec-deck')!.supersetGroup).toBeUndefined();
  });

  it('pairs every superset group within a template as exactly two exercises', () => {
    // The general form of the two checks above: whatever the labels are, a
    // group of one is a forgotten partner and a group of three is a collision.
    for (const template of plan.templates) {
      const groups = new Map<string, string[]>();
      for (const id of template.exerciseIds) {
        const group = byId.get(id)!.supersetGroup;
        if (!group) continue;
        (groups.get(group) ?? groups.set(group, []).get(group)!).push(id);
      }
      for (const [group, members] of groups) {
        expect(members, `${template.id} group "${group}"`).toHaveLength(2);
      }
    }
  });

  it('gives every scheduled exercise an RIR ladder and a rest interval', () => {
    for (const id of scheduledIds()) {
      const e = byId.get(id)!;
      expect(e.targetRirBySet, `${id} has no RIR ladder`).toBeDefined();
      expect(e.restSeconds, `${id} has no rest interval`).toBeDefined();
    }
  });

  it('reserves true failure for exercises that fail locally', () => {
    // "Failure is earned by the exercise." Nothing loaded by a belt, a
    // barbell, or both hands on dumbbells may reach RIR 0.
    const systemic = [
      'weighted-pullup',
      'back-squat',
      'incline-barbell-press',
      'incline-db-press',
      'romanian-deadlift',
      'bulgarian-split-squat',
    ];
    for (const id of systemic) {
      const ladder = byId.get(id)!.targetRirBySet!;
      expect(Math.min(...ladder), `${id} reaches failure`).toBeGreaterThanOrEqual(1);
    }
    // And the lateral raise, the priority-1 lever, is failure on every set —
    // unchanged from v2, and now appearing identically in both upper days.
    expect(byId.get('cable-lateral-raise')!.targetRirBySet).toEqual([0]);
  });

  it('offers alternates for every lift the program schedules', () => {
    for (const id of scheduledIds()) {
      const alternates = byId.get(id)!.alternates ?? [];
      expect(alternates.length, `${id} has no alternates`).toBeGreaterThan(0);
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

  it('gives every alternate the fields the session screen needs', () => {
    const alternateIds = new Set(plan.exercises.flatMap((e) => e.alternates ?? []));
    for (const id of alternateIds) {
      const e = byId.get(id)!;
      expect(e.targetRirBySet, `${id} has no RIR ladder`).toBeDefined();
      expect(e.restSeconds, `${id} has no rest interval`).toBeDefined();
      expect(e.muscles.length, `${id} has no muscles`).toBeGreaterThan(0);
    }
  });

  it('keeps a unilateral swap worth the same volume as the lift it replaces', () => {
    const bilateral = byId.get('leg-press')!;
    const single = byId.get('single-leg-leg-press')!;
    expect(single.defaultSets).toBe(bilateral.defaultSets);
    const quads = (e: typeof single) => e.muscles.find((m) => m.muscle === 'quads')!.fraction;
    expect(quads(single)).toBe(quads(bilateral));
  });

  // ------------------------------------------------------------------------
  // Real delivered volume, per the document's own "per 6-day cycle,
  // converted to a weekly rate" framing. Where these hold or improve on v2's
  // verified numbers, asserted plainly. Where the document's SUMMARY table
  // claims a number its own detailed per-session tables do not deliver, that
  // is called out explicitly rather than quietly matched to the summary.
  // ------------------------------------------------------------------------

  it('holds every priority-1/2/3 muscle in range — the document\'s headline claim', () => {
    const rows = perCycleVolume().rows;
    for (const row of rows.filter((r) => r.priority !== undefined)) {
      expect(row.status, `${row.muscle} (priority ${row.priority}) is ${row.status}`).toBe(
        'in-range',
      );
    }
  });

  const holds: Partial<Record<MuscleGroup, number>> = {
    sideDelts: 7,
    latsWidth: 7,
    quads: 12 + 5 / 6, // 11 sets/cycle
  };

  it.each(Object.entries(holds))('puts %s at a %d weekly rate, matching the document', (muscle, rate) => {
    expect(weeklyRate(muscle as MuscleGroup)).toBeCloseTo(rate, 5);
  });

  it('REGRESSION: chest total drops below its own 10-set floor', () => {
    // v2 delivered exactly 10 (verified in the prior revision of this test),
    // sitting at the floor of its own 10-16 target. The document's summary
    // table claims v3 raises this to 11 ("up"). It does not: moving the
    // low-to-high cable fly out of Upper B without adding anything to Upper B
    // in its place, combined with dropping weighted-dip (which also hit
    // chest) entirely, leaves only three chest-contributing exercises across
    // the whole cycle — 8 sets, a 9.33 weekly rate, genuinely under target.
    //
    // Not silently fixed here. The fix is a program decision (add a set
    // somewhere, or accept the lower number) and belongs in PROGRAM-V3.md,
    // not invented by the test that checks it.
    const rate = weeklyRate('chest');
    expect(rate).toBeCloseTo(9 + 1 / 3, 5);
    const target = plan.volumeTargets.find((t) => t.muscle === 'chest')!;
    expect(rate, 'chest is now below its own target minimum').toBeLessThan(target.minSetsPerWeek);
  });

  it('REGRESSION: upper back and calves also drop just under their floors', () => {
    // v2: upper back 12.5 (target 12-18), calves 6.0 (target 6-12) — both at
    // or above the floor. v3's per-session set reductions (romanian-deadlift
    // 3->2, standing-calf-raise unchanged but seated-cable-row/chest-row also
    // cut) land both just under. Marginal — a fraction of a set — but real,
    // and worth knowing before assuming the volume screen will read green.
    const upperBackRate = weeklyRate('upperBack');
    const calvesRate = weeklyRate('calves');
    expect(upperBackRate).toBeCloseTo(11 + 2 / 3, 5);
    expect(calvesRate).toBeCloseTo(5 + 5 / 6, 5);
    expect(upperBackRate).toBeLessThan(plan.volumeTargets.find((t) => t.muscle === 'upperBack')!.minSetsPerWeek);
    expect(calvesRate).toBeLessThan(plan.volumeTargets.find((t) => t.muscle === 'calves')!.minSetsPerWeek);
  });

  it('leaves direct arm work below target, same gap v2 had — not new, not fixed', () => {
    // v1 carried an incline DB curl; neither v2 nor v3 does. Arms are still
    // entirely secondary volume off pulls and presses.
    const biceps = weeklyRate('biceps');
    const triceps = weeklyRate('triceps');
    const bicepsTarget = plan.volumeTargets.find((t) => t.muscle === 'biceps')!;
    const tricepsTarget = plan.volumeTargets.find((t) => t.muscle === 'triceps')!;
    expect(biceps).toBeLessThan(bicepsTarget.minSetsPerWeek);
    expect(triceps).toBeLessThan(tricepsTarget.minSetsPerWeek);
  });

  it('drops hanging leg raise to 2 sets, taking abs from at-floor to under', () => {
    // v2: hanging-leg-raise at 3 sets put abs exactly at its 3-set floor.
    // v3's Lower A cuts it to 2, per the document's own table — abs is now
    // genuinely under, not a rounding artifact of the 6-vs-7-day conversion.
    const abs = weeklyRate('abs');
    const target = plan.volumeTargets.find((t) => t.muscle === 'abs')!;
    expect(abs).toBeCloseTo(7 / 3, 5);
    expect(abs).toBeLessThan(target.minSetsPerWeek);
  });
});
