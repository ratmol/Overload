import { describe, expect, it } from 'vitest';
import { firstWorkingSetAt, elapsedSeconds, gymTimeSeconds } from '../src/session.js';

const s = (timestamp: string, isWarmup = false) => ({ timestamp, isWarmup });

describe('firstWorkingSetAt', () => {
  it('is null when nothing is logged', () => {
    expect(firstWorkingSetAt([])).toBeNull();
  });

  it('is null when only warm-ups are logged — the clock has not started', () => {
    expect(firstWorkingSetAt([s('2026-08-31T10:00:00.000Z', true)])).toBeNull();
  });

  it('ignores warm-ups even when they precede the first working set', () => {
    const sets = [
      s('2026-08-31T10:00:00.000Z', true),
      s('2026-08-31T10:05:00.000Z'),
      s('2026-08-31T10:12:00.000Z'),
    ];
    expect(firstWorkingSetAt(sets)).toBe('2026-08-31T10:05:00.000Z');
  });

  it('takes the earliest working set regardless of logging order', () => {
    const sets = [s('2026-08-31T10:30:00.000Z'), s('2026-08-31T10:05:00.000Z')];
    expect(firstWorkingSetAt(sets)).toBe('2026-08-31T10:05:00.000Z');
  });
});

describe('elapsedSeconds', () => {
  it('counts whole seconds between two timestamps', () => {
    expect(elapsedSeconds('2026-08-31T10:00:00.000Z', '2026-08-31T11:04:23.000Z')).toBe(3863);
  });

  it('clamps a backwards clock to zero rather than reporting a negative session', () => {
    expect(elapsedSeconds('2026-08-31T10:05:00.000Z', '2026-08-31T10:00:00.000Z')).toBe(0);
  });
});

describe('gymTimeSeconds', () => {
  it('is null until a working set exists', () => {
    expect(gymTimeSeconds([s('2026-08-31T10:00:00.000Z', true)], '2026-08-31T11:00:00.000Z')).toBeNull();
  });

  it('measures first working set to finish, ignoring the warm-up before it', () => {
    const sets = [s('2026-08-31T09:50:00.000Z', true), s('2026-08-31T10:00:00.000Z')];
    // Finish 47m30s after the working set, not 57m30s after the warm-up.
    expect(gymTimeSeconds(sets, '2026-08-31T10:47:30.000Z')).toBe(2850);
  });
});
