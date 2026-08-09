/**
 * The dashboard. Trend, estimated expenditure, target, and the sentence
 * explaining the last change.
 *
 * Every number here is rendered with the engine's own reason string next to it.
 * Nothing on this screen is computed in this file — if a figure appears without
 * an explanation the engine generated, that is a bug, not a layout choice.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { trendSlopePerDay, trendWarmupDays } from '@overload/engine';
import { db } from '../../db/db.js';
import { loadNutritionState } from '../../db/nutrition.js';
import { todayIso } from '../../db/queries.js';
import { go } from '../../lib/route.js';
import { lb, shortDate } from '../../lib/format.js';
import { computeReadiness } from '../../lib/readiness.js';
import { TrendChart } from './TrendChart.js';
import { AdjustmentCard } from './AdjustmentCard.js';
import { ReadinessCard } from './ReadinessCard.js';

export function BodyScreen() {
  const today = todayIso();

  const state = useLiveQuery(async () => {
    const nutrition = await loadNutritionState(today);
    const adjustments = await db.adjustments.orderBy('date').reverse().limit(5).toArray();
    return { ...nutrition, adjustments };
  }, [today]);

  if (!state) return <div className="empty">…</div>;

  const { profile, target, trend, intake, estimate, decision, tagged, adjustments, latestRaw } =
    state;

  if (!profile || !target) {
    return (
      <main>
        <section className="sheet">
          <p className="eyebrow">Body</p>
          <h1>Not set up yet</h1>
          <p className="hint">
            The engine needs a goal, an acceptable rate band and a starting calorie target
            before any of this means anything. It will not invent them.
          </p>
          <div className="btn-row">
            <button className="btn" onClick={() => go('/setup')}>
              Set up
            </button>
          </div>
        </section>
      </main>
    );
  }

  // 28 days matches the TDEE window, so the rate shown here is the rate the
  // estimate was actually built from rather than a second, differently-windowed
  // number that quietly disagrees with it.
  const slope = trendSlopePerDay(trend, 28);
  const ratePerWeek = slope === null ? null : slope * 7;
  const [bandLo, bandHi] = profile.targetRateBandLbPerWeek;
  const inBand = ratePerWeek !== null && ratePerWeek >= bandLo && ratePerWeek <= bandHi;

  return (
    <main>
      <ReadinessCard readiness={computeReadiness(today, trend, intake)} />

      <section className="sheet">
        <p className="eyebrow">Weight trend</p>
        <div className="headline">
          <span className="headline-value">
            {trend.length > 0 ? lb(Math.round(trend[trend.length - 1]!.trend * 10) / 10) : '—'}
          </span>
          <span className="headline-unit">lb trend</span>
        </div>
        <p className="day-row-meta">
          {latestRaw
            ? `Last weigh-in ${lb(latestRaw.weightLb)} lb on ${shortDate(latestRaw.date)}`
            : 'No weigh-ins yet'}
        </p>

        <TrendChart series={trend} />

        <dl>
          <div className="stat-row">
            <dt>Rate, last 28 days</dt>
            <dd data-tone={ratePerWeek === null ? undefined : inBand ? 'ok' : 'mark'}>
              {ratePerWeek === null
                ? '—'
                : `${ratePerWeek >= 0 ? '+' : ''}${ratePerWeek.toFixed(2)} lb/wk`}
            </dd>
          </div>
          <div className="stat-row">
            <dt>Target band</dt>
            <dd>
              {bandLo.toFixed(2)} to {bandHi.toFixed(2)} lb/wk
            </dd>
          </div>
        </dl>

        {estimate?.warmingUp && (
          <p className="reason" data-outcome="stalled">
            The trend filter has not settled. For roughly the first {trendWarmupDays()} days it
            reads the rate of change as <em>slower</em> than it is, which looks like "not gaining
            fast enough" and invites adding calories you do not need. The engine will not act on
            it, and neither should you.
          </p>
        )}
      </section>

      <section className="sheet">
        <p className="eyebrow">Estimated expenditure</p>
        {estimate === null ? (
          <>
            <div className="headline">
              <span className="headline-value">—</span>
            </div>
            <p className="hint">
              Needs both intake and weigh-ins in the same window. Import a food log or add a
              day by hand.
            </p>
            <div className="btn-row">
              <button className="btn" onClick={() => go('/intake')}>
                Intake
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="headline">
              <span className="headline-value">{estimate.kcal}</span>
              <span className="headline-unit">kcal/day</span>
            </div>
            <p className="day-row-meta">
              {estimate.low}–{estimate.high} kcal ·{' '}
              <span className="badge" data-tone={estimate.confidence === 'high' ? undefined : 'mark'}>
                {estimate.confidence} confidence
              </span>
            </p>
            <p className="reason">{estimate.reason}</p>
            <dl>
              <div className="stat-row">
                <dt>Logged days</dt>
                <dd>
                  {estimate.loggedDays}/{estimate.windowDays}
                </dd>
              </div>
              <div className="stat-row">
                <dt>Weigh-in days</dt>
                <dd>
                  {estimate.weighInDays}/{estimate.windowDays}
                </dd>
              </div>
              <div className="stat-row">
                <dt>Energy density used</dt>
                <dd>{estimate.energyDensityPerLb} kcal/lb</dd>
              </div>
            </dl>
            <p className="hint">
              Not 3500. That figure is the density of body fat; tissue gained on a lean gain is
              a mix, and using 3500 overfeeds by roughly 200 kcal/day.
            </p>
          </>
        )}
      </section>

      <AdjustmentCard today={today} target={target} decision={decision} />

      {tagged && (
        <section className="sheet">
          <p className="eyebrow">Shift days vs off days</p>
          <dl>
            <div className="stat-row">
              <dt>Shift days</dt>
              <dd>
                {tagged.meanShiftKcal} kcal × {tagged.shiftDays}
              </dd>
            </div>
            <div className="stat-row">
              <dt>Off days</dt>
              <dd>
                {tagged.meanOffKcal} kcal × {tagged.offDays}
              </dd>
            </div>
            <div className="stat-row">
              <dt>Difference</dt>
              <dd data-tone={tagged.isSignificant ? 'mark' : undefined}>
                {tagged.deltaKcal >= 0 ? '+' : ''}
                {tagged.deltaKcal} ± {tagged.marginKcal}
              </dd>
            </div>
          </dl>
          <p className="reason">{tagged.reason}</p>
        </section>
      )}

      {adjustments.length > 0 && (
        <section className="sheet">
          <p className="eyebrow">Change history</p>
          {adjustments.map((a) => (
            <div className="history-row" key={a.id}>
              <span className="history-date">{shortDate(a.date)}</span>
              <span className="history-sets">
                <strong>
                  {a.previousTarget} → {a.newTarget} kcal
                </strong>
                <br />
                <span className="muted">{a.reason}</span>
              </span>
            </div>
          ))}
        </section>
      )}

      <div className="btn-row">
        <button className="btn" data-tone="quiet" onClick={() => go('/intake')}>
          Intake
        </button>
        <button className="btn" data-tone="quiet" onClick={() => go('/setup')}>
          Setup
        </button>
      </div>
    </main>
  );
}
