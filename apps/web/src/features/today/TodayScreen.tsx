import { useLiveQuery } from 'dexie-react-hooks';
import { daysBetween, dueForRest, nextInRotation } from '@overload/engine';
import { db } from '../../db/db.js';
import { todayIso } from '../../db/queries.js';
import { moveTemplateInDisplayOrder, orderedTemplateIds } from '../../db/ui-prefs.js';
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
    // This is also the ROTATION order for a rolling program — it stays plan
    // order even when the list below is displayed in a different order, so
    // rearranging your own screen never changes which day "Next" points at.
    const planOrder = plan?.templateOrder ?? [];
    const baseOrder = [...stored]
      .sort(
        (a, b) =>
          (planOrder.indexOf(a.id) + 1 || Number.MAX_SAFE_INTEGER) -
          (planOrder.indexOf(b.id) + 1 || Number.MAX_SAFE_INTEGER),
      )
      .map((t) => t.id);
    const displayOrder = await orderedTemplateIds(baseOrder);
    const byId = new Map(stored.map((t) => [t.id, t]));
    const templates = displayOrder
      .map((id) => byId.get(id))
      .filter((t): t is NonNullable<typeof t> => !!t);

    const sessions = await db.sessions.orderBy('date').toArray();
    const setCounts = new Map<string, number>();
    for (const s of await db.sets.toArray()) {
      setCounts.set(s.sessionId, (setCounts.get(s.sessionId) ?? 0) + 1);
    }
    return {
      templates,
      sessions,
      plan,
      setCounts,
      next: nextInRotation(planOrder, sessions).templateId,
      restDue: dueForRest(sessions, today),
    };
  }, [today]);

  if (!data) return <div className="empty">Opening the logbook…</div>;

  const { templates, sessions, plan, setCounts, next, restDue } = data;

  function move(templateId: string, direction: -1 | 1) {
    void moveTemplateInDisplayOrder(
      templates.map((t) => t.id),
      templateId,
      direction,
    );
  }

  return (
    <main>
      <DeloadNotice today={today} sessions={sessions} />

      <section className="sheet">
        <p className="eyebrow">Today</p>
        <h1>{longDate(today)}</h1>
        <p className="muted">{plan?.name ?? 'No program loaded'}</p>
      </section>

      <WeighIn date={today} />

      {restDue && (
        <div className="notice" role="status">
          <strong>Two training days in a row</strong>
          <p className="hint">
            The one non-negotiable rule of a rolling program: never three in a row. Shift the
            rest day rather than skip it — the queue does not mind waiting.
          </p>
        </div>
      )}

      <section className="sheet">
        <p className="eyebrow">Train</p>
        <div className="day-list">
          {templates.map((t, i) => {
            const forTemplate = sessions.filter((s) => s.templateId === t.id);
            const last = forTemplate[forTemplate.length - 1];
            const open = last?.date === today;
            const loggedToday = open ? (setCounts.get(last.id) ?? 0) : 0;
            const isNext = t.id === next;
            return (
              <div key={t.id} className="day-row" data-open={open}>
                <button className="day-row-main" onClick={() => go(`/session/${t.id}/${today}`)}>
                  <span className="day-row-name">
                    {t.name}
                    {isNext && !open && (
                      <span className="badge day-row-badge" aria-label="Next in rotation">
                        Next
                      </span>
                    )}
                  </span>
                  <br />
                  <span className="day-row-meta">
                    {t.exerciseIds.length} lifts
                    {open
                      ? ` · in progress, ${loggedToday} ${loggedToday === 1 ? 'set' : 'sets'}`
                      : last
                        ? ` · last ${daysAgo(daysBetween(last.date, today))}`
                        : ' · never done'}
                  </span>
                </button>
                <div className="day-row-reorder">
                  <button
                    type="button"
                    aria-label={`Move ${t.name} up`}
                    disabled={i === 0}
                    onClick={() => move(t.id, -1)}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${t.name} down`}
                    disabled={i === templates.length - 1}
                    onClick={() => move(t.id, 1)}
                  >
                    ▼
                  </button>
                </div>
                <span className="day-row-go" aria-hidden="true">
                  {open ? '●' : '→'}
                </span>
              </div>
            );
          })}
        </div>
        <p className="hint">
          &ldquo;Next&rdquo; is a recommendation, not a rule — the rotation is a queue, not a
          calendar. Any day still opens whatever you tap. Use the arrows to arrange the list
          itself — that is a screen preference and does not change what Next recommends.
        </p>
      </section>
    </main>
  );
}
