# overload

An open-source, local-first training and body-data logger with an adaptive
calorie engine that explains every number it produces.

No server. No account. No sync. Your data stays in your browser.

**Status:** engine built and tested. The app is not built yet.

| | |
|---|---|
| [`packages/engine`](packages/engine) | The adaptive engine. Pure TypeScript, 148 tests. **Start here.** |
| `apps/web` | React PWA. Not built yet. |
| [`data/plan.json`](data/plan.json) | The training program as data, not code. |
| [`docs/ALGORITHM.md`](docs/ALGORITHM.md) | Every constant and the assumption behind it. |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Irreversible calls and what they cost. |

```bash
npm install
npm test
```

## What it does that other trackers don't

**System load.** On weighted pull-ups and dips it tracks `bodyweight + added
weight`, not belt weight. During a lean gain, +45 lb at 132 lb bodyweight and
+45 lb at 142 lb are ten pounds apart in real work, and belt weight alone makes
genuine progress look like a plateau.

**An energy density constant that isn't 3500.** 3500 kcal/lb is body fat. Tissue
gained on a lean gain is a mix, and using the textbook number overfeeds by
roughly 200 kcal/day. [Why this matters](packages/engine#1-the-energy-density-constant-is-not-3500).

**Separate expenditure for active and rest days.** A standing shift can run
300-500 kcal above an off day. Eating one flat number means a surplus on half of
them.

**An engine that refuses to guess.** Nine hard guardrails, an explicit confidence
model, and a rule that no calorie change happens unless a plain-English reason
for it can be generated.

MIT. Not medical advice.
