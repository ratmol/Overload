import { clock } from '../../lib/format.js';
import type { RestTimer } from '../../lib/useRestTimer.js';

export function RestBar({ rest }: { rest: RestTimer }) {
  const over = rest.running && rest.remaining <= 0;
  const pct = rest.running
    ? Math.max(0, Math.min(100, (rest.remaining / rest.targetSec) * 100))
    : 100;

  return (
    <div className="rest">
      <span className="rest-clock" data-over={over}>
        {clock(rest.running ? rest.remaining : rest.targetSec)}
      </span>
      <div
        className="rest-bar"
        data-over={over}
        role="progressbar"
        aria-label="Rest remaining"
        aria-valuenow={Math.round(pct)}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="rest-adjust">
        <button onClick={() => rest.adjustTarget(-30)} aria-label="Rest target down 30 seconds">
          −30
        </button>
        <button onClick={() => rest.adjustTarget(30)} aria-label="Rest target up 30 seconds">
          +30
        </button>
        <button onClick={() => (rest.running ? rest.stop() : rest.start())}>
          {rest.running ? 'Stop' : 'Start'}
        </button>
      </div>
    </div>
  );
}
