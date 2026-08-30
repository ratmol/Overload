/**
 * Every read and write the UI is allowed to make. Components do not touch
 * Dexie directly.
 *
 * Nothing here stores a derived value. `systemLoad`, "last session", and the
 * next prescription are all computed from raw rows at read time.
 */
import type { IsoDate, Session, SessionPerformance, SetLog } from '@overload/engine';
import { db, newId } from './db.js';
import { touch, tombstone } from './sync-bookkeeping.js';

/**
 * Today as a LOCAL calendar date.
 *
 * The engine's date maths is UTC-only, which is right for arithmetic on stored
 * dates but wrong for deciding what "today" means to someone in a gym at 10pm.
 * The conversion to a calendar string happens exactly here, once; after this
 * the value is an opaque YYYY-MM-DD and the engine's UTC parsing of it is
 * consistent with itself.
 */
export function todayIso(): IsoDate {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** The open session for a date, if one exists. One session per day per template. */
async function findSession(templateId: string, date: IsoDate) {
  return db.sessions.where('[templateId+date]').equals([templateId, date]).first();
}

/**
 * Read-only lookup, for opening a session screen without creating a row.
 *
 * Opening a day just to see what is on it — then leaving — must not write
 * anything. See `startSession` for the create side of this.
 */
export async function existingSessionId(templateId: string, date: IsoDate): Promise<string | null> {
  const existing = await findSession(templateId, date);
  return existing?.id ?? null;
}

/**
 * Finds today's session for this template, or creates one on first write.
 *
 * A session row used to be created the moment the screen opened, so that a
 * session you walked out of still existed as a record of the day. That also
 * meant opening a day purely to look at what is on it — then backing out —
 * created a real row: it showed as "in progress" on Today, and worse, it
 * counted toward the rotation queue and the session-counted deload timer
 * (`nextInRotation`, `accumulationSessionsSince` in packages/engine), which
 * both key off "a session exists for this date", not off any set being
 * logged. Looking, not training, was silently advancing the program.
 *
 * The row is created here instead, lazily, at the point of the first actual
 * write — a set, a flag, a swap — so "opening a day" and "starting a
 * session" are no longer the same action.
 */
export async function startSession(
  templateId: string,
  date: IsoDate,
  isDeload: boolean,
): Promise<string> {
  const existing = await findSession(templateId, date);
  if (existing) return existing.id;
  const id = newId();
  await db.sessions.add({ id, date, templateId, isDeload });
  await touch('sessions', [id]);
  return id;
}

/**
 * Stamp the moment the session was finished. The gym-time total is computed
 * from this and the first working set — see `gymTimeSeconds`; nothing derived
 * is stored.
 */
export async function finishSession(sessionId: string): Promise<void> {
  await db.sessions.update(sessionId, { finishedAt: new Date().toISOString() });
  await touch('sessions', [sessionId]);
}

export async function setSessionFlags(
  sessionId: string,
  patch: Partial<
    Pick<
      Session,
      | 'isDeload'
      | 'sleepQuality'
      | 'jointPainFlag'
      | 'dreadFlag'
      | 'restingHeartRateBpm'
      | 'swaps'
      | 'skips'
      | 'supersetsOff'
    >
  >,
): Promise<void> {
  await db.sessions.update(sessionId, patch);
  await touch('sessions', [sessionId]);
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

export async function logSet(input: {
  sessionId: string;
  exerciseId: string;
  addedWeightLb: number;
  reps: number;
  rir: number;
  isWarmup?: boolean;
}): Promise<string> {
  const id = newId();
  await db.sets.add({
    id,
    sessionId: input.sessionId,
    exerciseId: input.exerciseId,
    addedWeightLb: input.addedWeightLb,
    reps: input.reps,
    rir: input.rir,
    isWarmup: input.isWarmup ?? false,
    timestamp: new Date().toISOString(),
  });
  await touch('sets', [id]);
  return id;
}

export async function deleteSet(id: string): Promise<void> {
  await db.sets.delete(id);
  await tombstone('sets', [id]);
}

/**
 * Wipes training history, leaving the program and settings.
 *
 * Every removed row gets a tombstone, because this one IS a deliberate
 * deletion — unlike a JSON import, which replaces the local database without
 * anybody deciding to delete anything.
 */
export async function eraseHistory(): Promise<void> {
  const [sessions, sets, weights, intake, adjustments] = await Promise.all([
    db.sessions.toCollection().primaryKeys(),
    db.sets.toCollection().primaryKeys(),
    db.weights.toCollection().primaryKeys(),
    db.intake.toCollection().primaryKeys(),
    db.adjustments.toCollection().primaryKeys(),
  ]);

  await db.transaction(
    'rw',
    [db.sessions, db.sets, db.weights, db.intake, db.adjustments],
    async () => {
      await db.sessions.clear();
      await db.sets.clear();
      await db.weights.clear();
      await db.intake.clear();
      await db.adjustments.clear();
    },
  );

  await tombstone('sessions', sessions as string[]);
  await tombstone('sets', sets as string[]);
  await tombstone('weights', weights as string[]);
  await tombstone('intake', intake as string[]);
  await tombstone('adjustments', adjustments as string[]);
}

/** One exercise's sets within one session, in the order they were performed. */
export async function setsForExerciseInSession(
  exerciseId: string,
  sessionId: string,
): Promise<SetLog[]> {
  const rows = await db.sets.where('[exerciseId+sessionId]').equals([exerciseId, sessionId]).toArray();
  return rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Every past session's working sets for one exercise, oldest first, in the
 * shape `nextPrescription` expects.
 *
 * Warm-ups are dropped here, deliberately, because a 45 lb warm-up in the set
 * list would make `Math.max(addedWeightLb)` correct but the total-rep
 * comparison meaningless.
 */
export async function performanceHistory(
  exerciseId: string,
  opts: { excludeSessionId?: string; limit?: number } = {},
): Promise<SessionPerformance[]> {
  const sets = await db.sets.where('exerciseId').equals(exerciseId).toArray();
  const sessionIds = [...new Set(sets.map((s) => s.sessionId))].filter(
    (id) => id !== opts.excludeSessionId,
  );
  if (sessionIds.length === 0) return [];

  const sessions = await db.sessions.bulkGet(sessionIds);
  const byId = new Map(sessions.filter((s): s is NonNullable<typeof s> => !!s).map((s) => [s.id, s]));

  const grouped = new Map<string, SetLog[]>();
  for (const s of sets) {
    if (!byId.has(s.sessionId)) continue;
    if (s.isWarmup) continue;
    const list = grouped.get(s.sessionId);
    if (list) list.push(s);
    else grouped.set(s.sessionId, [s]);
  }

  const out: SessionPerformance[] = [];
  for (const [sessionId, list] of grouped) {
    const session = byId.get(sessionId)!;
    if (list.length === 0) continue;
    out.push({
      date: session.date,
      isDeload: session.isDeload,
      sets: list
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .map((s) => ({ addedWeightLb: s.addedWeightLb, reps: s.reps, rir: s.rir })),
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return opts.limit ? out.slice(-opts.limit) : out;
}

// ---------------------------------------------------------------------------
// Bodyweight
// ---------------------------------------------------------------------------

/**
 * Stage 1 needs bodyweight for exactly one reason: system load on pull-ups and
 * dips is meaningless without it. No trend, no TDEE, no calories — that is
 * Stage 3. This is a number the logger needs to do its own job.
 */
export async function logWeight(date: IsoDate, weightLb: number): Promise<void> {
  const existing = await db.weights.where('date').equals(date).first();
  if (existing) {
    await db.weights.update(existing.id, { weightLb });
    await touch('weights', [existing.id]);
    return;
  }
  const id = newId();
  await db.weights.add({
    id,
    date,
    weightLb,
    source: 'manual',
    flaggedOutlier: false,
  });
  await touch('weights', [id]);
}
