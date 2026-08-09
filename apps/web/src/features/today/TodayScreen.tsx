import { useLiveQuery } from 'dexie-react-hooks';
import { daysBetween } from '@overload/engine';
import { db } from '../../db/db.js';
import { todayIso } from '../../db/queries.js';
import { go } from '../../lib/route.js';
import { daysAgo, longDate } from '../../lib/format.js';
import { WeighIn } from './WeighIn.js';
import { DeloadNotice } from './DeloadNotice.js';

export function TodayScreen() {
  const today = todayIso();

  const data = useLiveQuery(async () => {
    const plan = await db.plan.get('current');
    const stored = await db.templates.toArray();
    // Program order, not alphabetical. Anything not in the plan's list (an
    // exercise day added by hand) sorts to the end rather than disappearing.
    const order = plan?.templateOrder ?? [];
    const templates = [...stored].sort(
      (a, b) =>
        (order.indexOf(a.id) + 1 || Number.MAX_SAFE_INTEGER) -
        (order.indexOf(b.id) + 1 || Number.MAX_SAFE_INTEGER),
    );
    const sessions = await db.sessions.orderBy('date').toArray();
    const setCounts = new Map<string, number>();
    for (const s of await db.sets.toArray()) {
      setCounts.set(s.sessionId, (setCounts.get(s.sessionId) ?? 0) + 1);
    }
    return { templates, sessions, plan, setCounts };
  }, [today]);

  if (!data) return <div className="empty">Opening the logbook…</div>;

  const { templates, sessions, plan, setCounts } = data;

  return (
    <main>
      <DeloadNotice today={today} sessions={sessions} />

      <section className="sheet">
        <p className="eyebrow">Today</p>
        <h1>{longDate(today)}</h1>
        <p className="muted">{plan?.name ?? 'No program loaded'}</p>
      </section>

      <WeighIn date={today} />

      <section className="sheet">
        <p className="eyebrow">Train</p>
        <div className="day-list">
          {templates.map((t) => {
            const forTemplate = sessions.filter((s) => s.templateId === t.id);
            const last = forTemplate[forTemplate.length - 1];
            const open = last?.date === today;
            const loggedToday = open ? (setCounts.get(last.id) ?? 0) : 0;
            return (
              <button
                key={t.id}
                className="day-row"
                data-open={open}
                onClick={() => go(`/session/${t.id}/${today}`)}
              >
                <span>
                  <span className="day-row-name">{t.name}</span>
                  <br />
                  <span className="day-row-meta">
                    {t.exerciseIds.length} lifts
                    {open
                      ? ` · in progress, ${loggedToday} ${loggedToday === 1 ? 'set' : 'sets'}`
                      : last
                        ? ` · last ${daysAgo(daysBetween(last.date, today))}`
                        : ' · never done'}
                  </span>
                </span>
                <span className="day-row-go" aria-hidden="true">
                  {open ? '●' : '→'}
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}
