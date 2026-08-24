/**
 * Pins the program's own claims about itself.
 *
 * `plan.json` is program v5 — the 1x4 Method (Eric Evans): 4 exercises per
 * session, one warm-up at 50% plus ONE work set to failure, 6-10 reps, double
 * progression. Three main days plus one optional accessory day. This is a
 * deliberate, large step down in volume from v3's rolling ~70 sets/week, and
 * the tests at the bottom pin that reality rather than pretending the volume
 * screen will read green: against the user's own targets, the method
 * under-doses every priority muscle. That is the method's trade (less volume,
 * more intensity), made visible, not a bug to fix.
 */
import { describe, expect, it } from 'vitest';
import { Plan, auditVolume, type MuscleGroup, type SetLog } from '@overload/engine';
import planJson from '../../../data/plan.json';

const plan = Plan.parse(planJson);
const byId = new Map(plan.exercises.map((e) => [e.id, e]));
const scheduledIds = () => new Set(plan.templates.flatMap((t) => t.exerciseIds));
const mainDayIds = () =>
  new Set(plan.templates.filter((t) => t.id !== 'day-4-acc').flatMap((t) => t.exerciseIds));

/**
 * One full week of the program: every template once, dated across a 7-day
 * window so a single `auditVolume` sweep catches all four. `auditVolume`
 * just counts real dated sets — there is no program-awareness in it.
 */
function perWeekVolume() {
  const sets: SetLog[] = [];
  const sessionDates = new Map<string, string>();
  const dayOffsets: Record<string, number> = {
    'day-1-cst': 1,
    'day-2-legs': 2,
    'day-3-bb': 4,
    'day-4-acc': 5,
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
  return { rows, totalSets: sets.length };
}

describe('plan.json is the 1x4 Method (program v5)', () => {
  it('parses against the engine schema, at file version 5', () => {
    // The FILE version counts migrations, not program revisions. v4 was the
    // rolling v3 program; this migration replaces it wholesale with the 1x4
    // Method — a version bump overwrites templates and the exercises it names.
    expect(plan.version).toBe(5);
  });

  it('falls back to a calendar deload — the 1x4 Method has a fixed week', () => {
    // v3 counted deloads by session because it had no week. The 1x4 Method is
    // a fixed 3(+1)-day split, so the session-counted timer is gone and the
    // engine uses deloadEveryWeeks again.
    expect(plan.deloadEverySessions).toBeUndefined();
    expect(plan.deloadEveryWeeks).toBe(6);
  });

  it('is four days, in Day 1-4 order, four exercises each', () => {
    expect(plan.templates.map((t) => t.id)).toEqual([
      'day-1-cst',
      'day-2-legs',
      'day-3-bb',
      'day-4-acc',
    ]);
    for (const template of plan.templates) {
      expect(template.exerciseIds, template.id).toHaveLength(4);
    }
  });

  it('prescribes exactly one work set on every scheduled exercise', () => {
    // The whole method: "1 work set taken to absolute failure." Not two, not a
    // ladder. A stray defaultSets of 2 silently doubles the day.
    for (const id of scheduledIds()) {
      expect(byId.get(id)!.defaultSets, `${id} is not a single work set`).toBe(1);
    }
  });

  it('takes every scheduled work set to failure — RIR 0', () => {
    // "Absolute failure with good form." v3's rule that systemic lifts never
    // reach RIR 0 is deliberately gone: the 1x4 Method fails on everything,
    // including the RDL and the presses. That is the method, and the risk of
    // it is called out in the exercise notes, not hidden.
    for (const id of scheduledIds()) {
      expect(byId.get(id)!.targetRirBySet, `${id} has no RIR target`).toEqual([0]);
    }
  });

  it('runs the three main days at 6-10 reps, the method\'s progression window', () => {
    // "6-10 reps. When you hit 10 clean reps, increase the weight next session
    // and drop back to 6." The accessory day is intentionally exempt — the
    // post gives no rep target for it, so neck/grip/ab work keeps sane ranges.
    for (const id of mainDayIds()) {
      expect(byId.get(id)!.defaultRepRange, `${id} is off the 6-10 window`).toEqual([6, 10]);
    }
  });

  it('runs straight sets, not supersets — no scheduled exercise carries a group', () => {
    // v3 supersetted antagonists to fit ~19 sets in 34 minutes. The 1x4 Method
    // is four straight sets. A leftover supersetGroup would make the session
    // screen silently pair two lifts the method means to run one at a time.
    for (const id of scheduledIds()) {
      expect(byId.get(id)!.supersetGroup, `${id} still has a superset group`).toBeUndefined();
    }
  });

  it('adds the four exercises the method needs and the library did not have', () => {
    expect(byId.get('cable-pushdown')!.muscles[0]!.muscle).toBe('triceps');
    expect(byId.get('neck-curl')!.muscles[0]!.muscle).toBe('neck');
    expect(byId.get('wrist-roller')!.muscles[0]!.muscle).toBe('forearms');
    expect(byId.get('cable-crunch')!.muscles[0]!.muscle).toBe('abs');
  });

  it('keeps every v3 exercise so old logged sets still resolve to a name', () => {
    // Same precedent as v2 keeping the deadlift and v3 keeping the dip: a
    // version bump drops exercises from the TEMPLATES, never from the library.
    for (const id of ['back-squat', 'weighted-pullup', 'hip-thrust', 'bulgarian-split-squat']) {
      expect(byId.has(id), `${id} was orphaned`).toBe(true);
      expect(scheduledIds().has(id), `${id} should be unscheduled now`).toBe(false);
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
  // The trade, made visible. The method spends volume to buy intensity, so
  // against the user's UNCHANGED targets (their goals did not move) the audit
  // reads under across the board. These pin that rather than quietly softening
  // the targets to make the screen green.
  // ------------------------------------------------------------------------

  it('logs 16 work sets across a full four-day week — the method\'s ceiling', () => {
    // 4 exercises x 1 set x 4 days. The three main days alone are 12; v3 ran
    // ~70. This is the "less volume" half of "less volume, more intensity",
    // stated as a number.
    expect(perWeekVolume().totalSets).toBe(16);
  });

  it('REGRESSION: every priority muscle lands under target — 1 set a week each', () => {
    // Side delts (P1), upper chest (P2), lat width and rear delts (P3),
    // lower traps (P4) each get a single direct set per week under this
    // program, far below the floors the user set for their own physique. The
    // volume screen will read red on the levers the user cares about most.
    // That is the honest cost of the switch, not something to engineer away.
    const rows = perWeekVolume().rows;
    const priority = rows.filter((r) => r.priority !== undefined);
    expect(priority.length).toBeGreaterThan(0);
    for (const row of priority) {
      expect(row.status, `${row.muscle} (priority ${row.priority}) is ${row.status}`).toBe('under');
    }
  });

  it('REGRESSION: nothing is over target — no muscle is even near its ceiling', () => {
    // The mirror image of the above: one set to failure cannot overshoot a
    // weekly maximum. Every muscle is at or below its floor.
    for (const row of perWeekVolume().rows) {
      expect(row.status, `${row.muscle} is ${row.status}`).not.toBe('over');
    }
  });

  it('leaves the priority-1 lever, side delts, on a single weekly set', () => {
    const rows = perWeekVolume().rows;
    const sideDelts = rows.find((r) => r.muscle === ('sideDelts' as MuscleGroup))!;
    expect(sideDelts.sets).toBe(1);
    expect(sideDelts.status).toBe('under');
  });
});
