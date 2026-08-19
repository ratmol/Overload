import { describe, expect, it } from 'vitest';
import { accumulationSessionsSince, dueForRest, nextInRotation } from '../src/rotation.js';

const ORDER = ['upper-a', 'lower-a', 'upper-b', 'lower-b'];

describe('nextInRotation', () => {
  it('starts at the top with no history', () => {
    const r = nextInRotation(ORDER, []);
    expect(r.templateId).toBe('upper-a');
    expect(r.reason).toContain('First session');
  });

  it('advances one position per completed session', () => {
    expect(nextInRotation(ORDER, [{ templateId: 'upper-a', date: '2026-08-01' }]).templateId).toBe(
      'lower-a',
    );
    expect(
      nextInRotation(ORDER, [
        { templateId: 'upper-a', date: '2026-08-01' },
        { templateId: 'lower-a', date: '2026-08-02' },
      ]).templateId,
    ).toBe('upper-b');
  });

  it('wraps from the last template back to the first', () => {
    const r = nextInRotation(ORDER, [{ templateId: 'lower-b', date: '2026-08-01' }]);
    expect(r.templateId).toBe('upper-a');
  });

  it('is a queue, not a calendar: rest-day gaps do not affect the sequence', () => {
    // Days 3 and 6 in the doc are rest days with no session at all. The
    // rotation only cares about the last completed template, never the date.
    const withGaps = [
      { templateId: 'upper-a', date: '2026-08-01' },
      { templateId: 'lower-a', date: '2026-08-02' },
      // an 11-day gap here changes nothing
      { templateId: 'upper-b', date: '2026-08-13' },
    ];
    expect(nextInRotation(ORDER, withGaps).templateId).toBe('lower-b');
  });

  it('uses only the MOST RECENT session, ignoring earlier order', () => {
    const outOfOrder = [
      { templateId: 'lower-b', date: '2026-08-01' },
      { templateId: 'upper-a', date: '2026-08-02' }, // logged out of sequence
    ];
    expect(nextInRotation(ORDER, outOfOrder).templateId).toBe('lower-a');
  });

  it('sorts by date rather than trusting array order', () => {
    const reversed = [
      { templateId: 'lower-a', date: '2026-08-02' },
      { templateId: 'upper-a', date: '2026-08-01' },
    ];
    expect(nextInRotation(ORDER, reversed).templateId).toBe('upper-b');
  });

  it('skips a session outside the rotation rather than getting stuck', () => {
    // An ad-hoc day, or a template a plan update has since dropped.
    const withAdHoc = [
      { templateId: 'upper-a', date: '2026-08-01' },
      { templateId: 'some-custom-day', date: '2026-08-02' },
    ];
    expect(nextInRotation(ORDER, withAdHoc).templateId).toBe('lower-a');
  });

  it('starts from the top when nothing in history matches the rotation at all', () => {
    const r = nextInRotation(ORDER, [{ templateId: 'legacy-day', date: '2026-08-01' }]);
    expect(r.templateId).toBe('upper-a');
    expect(r.reason).toContain('No session yet matches');
  });

  it('reports null with a reason on an empty rotation, rather than throwing', () => {
    const r = nextInRotation([], [{ templateId: 'upper-a', date: '2026-08-01' }]);
    expect(r.templateId).toBeNull();
  });

  it('a deload session still advances the rotation', () => {
    // A deload week still works through the sequence at reduced volume; it is
    // not a separate slot the rotation needs to know about.
    const withDeload = [{ templateId: 'upper-a', date: '2026-08-01', isDeload: true }];
    expect(nextInRotation(ORDER, withDeload).templateId).toBe('lower-a');
  });
});

describe('dueForRest', () => {
  const today = '2026-08-10';

  it('is false with no recent sessions', () => {
    expect(dueForRest([], today)).toBe(false);
  });

  it('is false after a single training day', () => {
    expect(dueForRest([{ date: '2026-08-09' }], today)).toBe(false);
  });

  it('is true after exactly two consecutive training days', () => {
    expect(dueForRest([{ date: '2026-08-08' }, { date: '2026-08-09' }], today)).toBe(true);
  });

  it('is false when there was a gap anywhere in the last two days', () => {
    // Trained two days ago, rested yesterday: the streak is already broken.
    expect(dueForRest([{ date: '2026-08-08' }], today)).toBe(false);
  });

  it('does not care about training further back than two days', () => {
    const longHistory = [
      { date: '2026-08-01' },
      { date: '2026-08-02' },
      { date: '2026-08-03' },
      { date: '2026-08-08' },
      { date: '2026-08-09' },
    ];
    expect(dueForRest(longHistory, today)).toBe(true);
  });
});

describe('accumulationSessionsSince', () => {
  it('counts inclusively from the block start when it is the very first session', () => {
    // No prior deload: blockStartDate IS the first session's own date, and
    // that session is real accumulation work, not a boundary marker.
    const sessions = [
      { date: '2026-08-01', isDeload: false },
      { date: '2026-08-02', isDeload: false },
    ];
    expect(accumulationSessionsSince(sessions, '2026-08-01')).toBe(2);
  });

  it('excludes the deload session that started the block, at the same boundary date', () => {
    // With a prior deload, blockStartDate IS the deload session's date. The
    // inclusive boundary must not double-count it.
    const sessions = [
      { date: '2026-08-01', isDeload: true },
      { date: '2026-08-02', isDeload: false },
      { date: '2026-08-03', isDeload: false },
    ];
    expect(accumulationSessionsSince(sessions, '2026-08-01')).toBe(2);
  });

  it('excludes sessions before the block start', () => {
    const sessions = [
      { date: '2026-07-30', isDeload: false },
      { date: '2026-08-01', isDeload: false },
    ];
    expect(accumulationSessionsSince(sessions, '2026-08-01')).toBe(1);
  });

  it('excludes every deload session, not only the boundary one', () => {
    const sessions = [
      { date: '2026-08-01', isDeload: false },
      { date: '2026-08-08', isDeload: true },
      { date: '2026-08-09', isDeload: false },
    ];
    expect(accumulationSessionsSince(sessions, '2026-08-01')).toBe(2);
  });
});
