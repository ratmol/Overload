import { describe, expect, it } from 'vitest';
import { detectDeload, type DeloadInputs } from '../src/deload.js';

const base: DeloadInputs = {
  today: '2026-09-01',
  blockStartDate: '2026-08-01',
  deloadEveryWeeks: 7,
  stalledExerciseIds: [],
  rirDriftPerSession: null,
  recentSessions: [],
};

describe('detectDeload', () => {
  it('does not recommend anything mid-block with no signals', () => {
    const r = detectDeload(base);
    expect(r.recommend).toBe(false);
    expect(r.signals).toEqual([]);
  });

  it('fires on the scheduled timer regardless of other signals', () => {
    const r = detectDeload({ ...base, today: '2026-09-20' });
    expect(r.recommend).toBe(true);
    expect(r.signals).toContain('scheduled');
  });

  it('does not fire on a single fatigue signal', () => {
    const r = detectDeload({ ...base, stalledExerciseIds: ['a', 'b'] });
    expect(r.signals).toEqual(['multiple-stalls']);
    expect(r.recommend).toBe(false);
  });

  it('fires when two independent fatigue signals are present', () => {
    const r = detectDeload({
      ...base,
      stalledExerciseIds: ['a', 'b'],
      rirDriftPerSession: -0.5,
    });
    expect(r.recommend).toBe(true);
    expect(r.signals).toHaveLength(2);
  });

  it('treats one stalled lift as insufficient for the stall signal', () => {
    const r = detectDeload({ ...base, stalledExerciseIds: ['a'] });
    expect(r.signals).not.toContain('multiple-stalls');
  });

  it('detects a trailing run of poor sleep', () => {
    const r = detectDeload({
      ...base,
      recentSessions: [
        { date: '2026-08-24', sleepQuality: 4 },
        { date: '2026-08-26', sleepQuality: 2 },
        { date: '2026-08-27', sleepQuality: 2 },
        { date: '2026-08-29', sleepQuality: 1 },
        { date: '2026-08-31', sleepQuality: 2 },
      ],
    });
    expect(r.signals).toContain('poor-sleep');
  });

  it('breaks the sleep run on a single good night', () => {
    const r = detectDeload({
      ...base,
      recentSessions: [
        { date: '2026-08-24', sleepQuality: 2 },
        { date: '2026-08-26', sleepQuality: 2 },
        { date: '2026-08-27', sleepQuality: 2 },
        { date: '2026-08-31', sleepQuality: 5 },
      ],
    });
    expect(r.signals).not.toContain('poor-sleep');
  });

  it('breaks a run on an unreported day rather than assuming', () => {
    const r = detectDeload({
      ...base,
      recentSessions: [
        { date: '2026-08-24', jointPainFlag: true },
        { date: '2026-08-26', jointPainFlag: true },
        { date: '2026-08-31' },
      ],
    });
    expect(r.signals).not.toContain('joint-pain');
  });

  it('detects joint pain across two consecutive sessions', () => {
    const r = detectDeload({
      ...base,
      recentSessions: [
        { date: '2026-08-26', jointPainFlag: false },
        { date: '2026-08-29', jointPainFlag: true },
        { date: '2026-08-31', jointPainFlag: true },
      ],
    });
    expect(r.signals).toContain('joint-pain');
  });

  it('says calories stay unchanged in every recommendation', () => {
    const r = detectDeload({ ...base, today: '2026-09-20' });
    expect(r.reason.toLowerCase()).toContain('calories');
  });

  it('always produces a non-empty reason', () => {
    expect(detectDeload(base).reason.length).toBeGreaterThan(0);
  });
});

describe('resting heart rate and dread', () => {
  const hr = (date: string, bpm: number) => ({ date, restingHeartRateBpm: bpm });

  it('fires when resting HR sits above baseline for several days', () => {
    const r = detectDeload({
      ...base,
      baselineRestingHeartRateBpm: 55,
      recentSessions: [hr('2026-08-24', 55), hr('2026-08-26', 61), hr('2026-08-29', 62), hr('2026-08-31', 60)],
    });
    expect(r.signals).toContain('resting-hr-elevated');
  });

  it('does not fire on a single elevated morning', () => {
    const r = detectDeload({
      ...base,
      baselineRestingHeartRateBpm: 55,
      recentSessions: [hr('2026-08-29', 55), hr('2026-08-31', 62)],
    });
    expect(r.signals).not.toContain('resting-hr-elevated');
  });

  it('needs a personal baseline, since absolute bpm means nothing on its own', () => {
    const r = detectDeload({
      ...base,
      recentSessions: [hr('2026-08-26', 75), hr('2026-08-29', 76), hr('2026-08-31', 77)],
    });
    expect(r.signals).not.toContain('resting-hr-elevated');
  });

  it('fires on dread across consecutive sessions', () => {
    const r = detectDeload({
      ...base,
      recentSessions: [
        { date: '2026-08-26', dreadFlag: false },
        { date: '2026-08-29', dreadFlag: true },
        { date: '2026-08-31', dreadFlag: true },
      ],
    });
    expect(r.signals).toContain('dread');
  });

  it('combines two of the new signals into a recommendation', () => {
    const r = detectDeload({
      ...base,
      baselineRestingHeartRateBpm: 55,
      recentSessions: [
        { date: '2026-08-26', restingHeartRateBpm: 62, dreadFlag: true },
        { date: '2026-08-29', restingHeartRateBpm: 63, dreadFlag: true },
        { date: '2026-08-31', restingHeartRateBpm: 61, dreadFlag: true },
      ],
    });
    expect(r.recommend).toBe(true);
  });
});
