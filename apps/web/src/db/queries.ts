/**
 * Every read and write the UI is allowed to make. Components do not touch
 * Dexie directly.
 *
 * Nothing here stores a derived value. `systemLoad`, "last session", and the
 * next prescription are all computed from raw rows at read time.
 */
import type { IsoDate, Session, SessionPerformance, SetLog } from '@overload/engine';
import { db, newId } from './db.js';

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

export async function startSession(
  templateId: string,
  date: IsoDate,
  isDeload: boolean,
): Promise<string> {
  const existing = await findSession(templateId, date);
  if (existing) return existing.id;
  const id = newId();
  await db.sessions.add({ id, date, templateId, isDeload });
  return id;
}

export async function setSessionFlags(
  sessionId: string,
  patch: Partial<Pick<Session, 'isDeload' | 'sleepQuality' | 'jointPainFlag' | 'dreadFlag'>>,
): Promise<void> {
  await db.sessions.update(sessionId, patch);
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
  return id;
}

export async function deleteSet(id: string): Promise<void> {
  await db.sets.delete(id);
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
    return;
  }
  await db.weights.add({
    id: newId(),
    date,
    weightLb,
    source: 'manual',
    flaggedOutlier: false,
  });
}
