/**
 * Weight trend, drawn by hand in SVG.
 *
 * There are two charts in this entire app. A charting library would be more
 * code than the charts, would need its own theming to match paper and ink, and
 * would draw the one thing that must not be drawn: a smooth line through the
 * raw readings, which is exactly the illusion of precision the EWMA exists to
 * avoid.
 *
 * What is drawn:
 *  - raw readings as small marks, because they are the data
 *  - the trend as the only continuous line, because it is the thing to read
 *  - flagged outliers hollow, so a downweighted point is visibly still there
 *
 * Nothing is deleted from this chart. An outlier is drawn differently, never
 * removed.
 */
import type { TrendPoint } from '@overload/engine';
import { lb, shortDate } from '../../lib/format.js';

const W = 600;
const H = 200;
const PAD = { top: 12, right: 8, bottom: 22, left: 34 };

export function TrendChart({ series, days = 90 }: { series: readonly TrendPoint[]; days?: number }) {
  const window = series.slice(-days);
  if (window.length < 2) {
    return <div className="empty">Not enough weigh-ins to draw a trend yet.</div>;
  }

  const values = window.flatMap((p) => (p.raw === null ? [p.trend] : [p.raw, p.trend]));
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // A flat month should look flat, not like a mountain range. Pad the domain so
  // ordinary daily noise cannot fill the full height of the box.
  const span = Math.max(hi - lo, 4);
  const mid = (hi + lo) / 2;
  const yMin = mid - span * 0.6;
  const yMax = mid + span * 0.6;

  const x = (i: number) =>
    PAD.left + (i / (window.length - 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) =>
    PAD.top + ((yMax - v) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);

  const trendPath = window
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.trend).toFixed(1)}`)
    .join(' ');

  const ticks = [yMax, mid, yMin];
  const first = window[0]!;
  const last = window[window.length - 1]!;

  return (
    <figure className="chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Weight trend, ${shortDate(first.date)} to ${shortDate(last.date)}, ${lb(first.trend)} to ${lb(last.trend)} lb`}
        preserveAspectRatio="none"
      >
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(v)}
              y2={y(v)}
              className="chart-rule"
              vectorEffect="non-scaling-stroke"
            />
            <text x={0} y={y(v) + 4} className="chart-label">
              {lb(Math.round(v * 10) / 10)}
            </text>
          </g>
        ))}

        {window.map((p, i) =>
          p.raw === null ? null : (
            <circle
              key={p.date}
              cx={x(i)}
              cy={y(p.raw)}
              r={p.flaggedOutlier ? 3.5 : 2}
              className={p.flaggedOutlier ? 'chart-dot-outlier' : 'chart-dot'}
              vectorEffect="non-scaling-stroke"
            />
          ),
        )}

        <path d={trendPath} className="chart-trend" vectorEffect="non-scaling-stroke" />

        <text x={PAD.left} y={H - 6} className="chart-label">
          {shortDate(first.date)}
        </text>
        <text x={W - PAD.right} y={H - 6} className="chart-label" textAnchor="end">
          {shortDate(last.date)}
        </text>
      </svg>
      <figcaption className="chart-key">
        <span className="chart-key-trend">line: trend</span>
        <span className="chart-key-dot">dot: weigh-in</span>
        <span className="chart-key-outlier">hollow: downweighted, not deleted</span>
      </figcaption>
    </figure>
  );
}
