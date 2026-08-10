import { describe, expect, it } from 'vitest';
import {
  bodyweightOn,
  deloadPrescription,
  DELOAD_RIR,
  isStalled,
  nextPrescription,
  rirDriftAtConstantLoad,
  rirLadder,
  systemLoad,
  type SessionPerformance,
} from '../src/progression.js';
import type { Exercise, WeightEntry } from '../src/types.js';

const pullup: Exercise = {
  id: 'weighted-pullup',
  name: 'Weighted pull-up',
  muscles: [{ muscle: 'lats', fraction: 1 }],
  isBodyweightLoaded: true,
  incrementLb: 2.5,
  defaultRepRange: [5, 8],
  defaultSets: 4,
  startingLoadLb: 30,
};

const bench: Exercise = {
  id: 'barbell-bench-press',
  name: 'Barbell flat bench press',
  muscles: [{ muscle: 'chest', fraction: 1 }],
  isBodyweightLoaded: false,
  incrementLb: 2.5,
  defaultRepRange: [8, 12],
  defaultSets: 4,
  startingLoadLb: 115,
};

const weights: WeightEntry[] = [
  { id: 'a', date: '2026-08-01', weightLb: 132.6, source: 'manual', flaggedOutlier: false },
  { id: 'b', date: '2026-08-15', weightLb: 135.0, source: 'manual', flaggedOutlier: false },
  { id: 'c', date: '2026-09-01', weightLb: 138.0, source: 'manual', flaggedOutlier: false },
];

const session = (date: string, sets: [number, number, number?][]): SessionPerformance => ({
  date,
  sets: sets.map(([addedWeightLb, reps, rir]) => ({ addedWeightLb, reps, rir: rir ?? 2 })),
});

describe('bodyweightOn', () => {
  it('uses the most recent prior entry, never a later one', () => {
    expect(bodyweightOn('2026-08-20', weights)).toBe(135.0);
  });

  it('returns null before any weight exists, rather than guessing', () => {
    expect(bodyweightOn('2026-07-01', weights)).toBeNull();
  });

  it('uses an exact same-day match when one exists', () => {
    expect(bodyweightOn('2026-08-15', weights)).toBe(135.0);
  });
});

describe('systemLoad', () => {
  it('is bodyweight plus belt weight on a bodyweight-loaded lift', () => {
    expect(systemLoad(pullup, 45, 132.6)).toBe(177.6);
  });

  it('shows the gain that belt weight alone hides during a lean gain', () => {
    // Same +45 belt, 10 lb heavier. This is the headline feature.
    expect(systemLoad(pullup, 45, 142)!).toBe(187);
    expect(systemLoad(pullup, 45, 142)! - systemLoad(pullup, 45, 132)!).toBe(10);
  });

  it('ignores bodyweight on an externally loaded lift', () => {
    expect(systemLoad(bench, 135, 132.6)).toBe(135);
  });

  it('returns null rather than a wrong number when bodyweight is unknown', () => {
    expect(systemLoad(pullup, 45, null)).toBeNull();
  });
});

describe('nextPrescription', () => {
  it('seeds from the plan on the first session', () => {
    const r = nextPrescription(pullup, []);
    expect(r.outcome).toBe('first-session');
    expect(r.load).toBe(30);
  });

  it('advances the load only when every set hit the top of the range', () => {
    const r = nextPrescription(pullup, [session('2026-08-03', [[30, 8], [30, 8], [30, 8], [30, 8]])]);
    expect(r.outcome).toBe('advance-load');
    expect(r.load).toBe(32.5);
  });

  it('holds the load when one set fell short', () => {
    const r = nextPrescription(pullup, [session('2026-08-03', [[30, 8], [30, 8], [30, 8], [30, 6]])]);
    expect(r.outcome).toBe('add-reps');
    expect(r.load).toBe(30);
  });

  it('uses a 2.5 lb increment on bodyweight-loaded lifts', () => {
    // At 132 lb bodyweight a 5 lb jump is ~4% of system load. 2.5 is the rule.
    const r = nextPrescription(pullup, [session('2026-08-03', [[45, 8], [45, 8], [45, 8], [45, 8]])]);
    expect(r.load - 45).toBe(2.5);
  });

  it('flags a stall only after TWO consecutive failed transitions', () => {
    // The plan says "two consecutive sessions with no rep or weight progress",
    // which needs three data points. Comparing a single pair flagged a stall
    // after one flat session, and two flat lifts on one bad day then became a
    // deload trigger.
    const history = [
      session('2026-07-27', [[30, 6], [30, 6], [30, 6], [30, 6]]),
      session('2026-08-03', [[30, 6], [30, 6], [30, 5], [30, 5]]),
      session('2026-08-10', [[30, 6], [30, 5], [30, 5], [30, 5]]),
    ];
    expect(nextPrescription(pullup, history).outcome).toBe('stalled');
    expect(isStalled(pullup, history)).toBe(true);
  });

  it('does not flag a stall after a single flat session', () => {
    const history = [
      session('2026-08-03', [[30, 6], [30, 6], [30, 5], [30, 5]]),
      session('2026-08-10', [[30, 6], [30, 5], [30, 5], [30, 5]]),
    ];
    expect(nextPrescription(pullup, history).outcome).not.toBe('stalled');
  });

  it('does not count a deload session as a stall', () => {
    // Deloads run at ~87.5% with belt weight stripped, so they look exactly
    // like a regression. Counting them could trigger a second deload
    // immediately after the first.
    const history = [
      session('2026-07-27', [[30, 8], [30, 8], [30, 8], [30, 8]]),
      { ...session('2026-08-03', [[0, 6], [0, 6]]), isDeload: true },
      session('2026-08-10', [[32.5, 5], [32.5, 5], [32.5, 5], [32.5, 5]]),
    ];
    expect(nextPrescription(pullup, history).outcome).not.toBe('stalled');
  });

  it('does not advance the load off a session that was cut short', () => {
    // `every` is vacuously true on one set, so a single good set used to earn
    // a load increase on a 4-set prescription.
    const r = nextPrescription(pullup, [session('2026-08-03', [[30, 8]])]);
    expect(r.outcome).not.toBe('advance-load');
    expect(r.load).toBe(30);
  });

  it('holds bodyweight-only work at the entry standard before adding load', () => {
    const r = nextPrescription({ ...pullup, entryStandardReps: 10 }, [
      session('2026-08-03', [[0, 8], [0, 7], [0, 6], [0, 6]]),
    ]);
    expect(r.load).toBe(0);
    expect(r.reason).toContain('10 strict');
  });

  it('releases the entry standard once every set clears it', () => {
    const r = nextPrescription({ ...pullup, entryStandardReps: 10 }, [
      session('2026-08-03', [[0, 10], [0, 10], [0, 11], [0, 10]]),
    ]);
    expect(r.reason).not.toContain('strict');
  });

  it('does not call it a stall when load rose and reps fell', () => {
    const history = [
      session('2026-08-03', [[30, 8], [30, 8], [30, 8], [30, 8]]),
      session('2026-08-10', [[32.5, 5], [32.5, 5], [32.5, 5], [32.5, 5]]),
    ];
    expect(nextPrescription(pullup, history).outcome).toBe('add-reps');
  });

  it('does not call it a stall on a single session of history', () => {
    expect(
      nextPrescription(pullup, [session('2026-08-03', [[30, 5], [30, 5]])]).outcome,
    ).toBe('add-reps');
  });

  it('always produces a non-empty reason string', () => {
    const cases: SessionPerformance[][] = [
      [],
      [session('2026-08-03', [[30, 8], [30, 8], [30, 8], [30, 8]])],
      [session('2026-08-03', [[30, 5]]), session('2026-08-10', [[30, 5]])],
    ];
    for (const h of cases) expect(nextPrescription(pullup, h).reason.length).toBeGreaterThan(0);
  });

  it('sorts unsorted history before deciding', () => {
    const a = session('2026-08-10', [[30, 8], [30, 8], [30, 8], [30, 8]]);
    const b = session('2026-08-03', [[30, 5], [30, 5], [30, 5], [30, 5]]);
    expect(nextPrescription(pullup, [a, b]).outcome).toBe('advance-load');
  });
});

describe('rirDriftAtConstantLoad', () => {
  it('is negative when the same load costs more effort each week', () => {
    const drift = rirDriftAtConstantLoad([
      session('2026-08-03', [[30, 6, 3], [30, 6, 3]]),
      session('2026-08-10', [[30, 6, 2], [30, 6, 2]]),
      session('2026-08-17', [[30, 6, 1], [30, 6, 1]]),
    ]);
    expect(drift).toBeLessThan(0);
  });

  it('returns null when the load varied, since the comparison is meaningless', () => {
    const drift = rirDriftAtConstantLoad([
      session('2026-08-03', [[30, 6, 3]]),
      session('2026-08-10', [[32.5, 6, 2]]),
      session('2026-08-17', [[35, 6, 1]]),
    ]);
    expect(drift).toBeNull();
  });

  it('returns null without enough sessions', () => {
    expect(rirDriftAtConstantLoad([session('2026-08-03', [[30, 6, 3]])])).toBeNull();
  });
});

describe('deloadPrescription', () => {
  it('strips all added weight from bodyweight-loaded lifts', () => {
    const d = deloadPrescription(pullup, {
      load: 45,
      targetReps: [5, 8],
      sets: 4,
      rirBySet: [2, 2, 2, 1],
      reason: '',
    });
    expect(d.load).toBe(0);
    expect(d.sets).toBe(2);
  });

  it('drops externally loaded lifts to ~87.5%, rounded to the increment', () => {
    const d = deloadPrescription(bench, {
      load: 135,
      targetReps: [8, 12],
      sets: 4,
      rirBySet: [2, 2, 2, 1],
      reason: '',
    });
    expect(d.load).toBeCloseTo(117.5, 1);
    expect(d.sets).toBe(2);
  });

  it('never drops below one set', () => {
    const d = deloadPrescription(bench, { load: 100, targetReps: [8, 12], sets: 1, rirBySet: [1], reason: '' });
    expect(d.sets).toBe(1);
  });
});


describe('the RIR ladder', () => {
  const ladderLift: Exercise = {
    ...bench,
    id: 'ladder',
    defaultSets: 3,
    // Program v2's core idea: only the last set is hard on a systemic compound.
    targetRirBySet: [2, 2, 1],
  };

  it('expands the ladder to exactly one entry per prescribed set', () => {
    expect(nextPrescription(ladderLift, []).rirBySet).toEqual([2, 2, 1]);
  });

  it('repeats the last rung when there are more sets than rungs', () => {
    // Without this a fourth set would get `undefined` and the UI would have to
    // invent a meaning for it.
    expect(rirLadder({ ...ladderLift, defaultSets: 5 }, 5)).toEqual([2, 2, 1, 1, 1]);
  });

  it('falls back for an exercise with no ladder, which is every v1 exercise', () => {
    expect(nextPrescription(bench, []).rirBySet).toEqual([2, 2, 2, 2]);
  });

  it('expresses true failure on every set', () => {
    const laterals: Exercise = { ...bench, id: 'lat', defaultSets: 4, targetRirBySet: [0] };
    expect(nextPrescription(laterals, []).rirBySet).toEqual([0, 0, 0, 0]);
  });

  it('carries the ladder through a load advance', () => {
    const history = [
      { date: '2026-08-01', sets: [[135, 12, 1], [135, 12, 1], [135, 12, 1]] },
    ].map((h) => ({
      date: h.date,
      sets: h.sets.map(([addedWeightLb, reps, rir]) => ({ addedWeightLb: addedWeightLb!, reps: reps!, rir: rir! })),
    }));
    const p = nextPrescription(ladderLift, history);
    expect(p.outcome).toBe('advance-load');
    expect(p.rirBySet).toEqual([2, 2, 1]);
  });

  it('OVERRIDES the ladder on a deload, including true-failure exercises', () => {
    // A deload that still demanded failure on lateral raises would not be a
    // deload. "Stop 4-5 reps short" beats whatever the ladder says.
    const laterals: Exercise = { ...bench, id: 'lat', defaultSets: 4, targetRirBySet: [0] };
    const normal = nextPrescription(laterals, []);
    expect(deloadPrescription(laterals, normal).rirBySet).toEqual([DELOAD_RIR, DELOAD_RIR]);
  });
});
