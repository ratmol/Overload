# overload

An open-source, local-first training and body-data logger with an adaptive
calorie engine that explains every number it produces.

No server. No account. No sync. Your data stays in your browser.

**Status:** the engine is built and tested (148 tests). The training logger runs
and installs as a PWA. The calorie side is not wired into the app yet.

| | |
|---|---|
| [`packages/engine`](packages/engine) | The adaptive engine. Pure TypeScript, 148 tests. **Start here.** |
| [`apps/web`](apps/web) | React PWA. The training logger. |
| [`data/plan.json`](data/plan.json) | The training program as data, not code. |
| [`docs/ALGORITHM.md`](docs/ALGORITHM.md) | Every constant and the assumption behind it. |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Irreversible calls and what they cost. |

```bash
npm install
npm run dev        # the logger, on :5173
npm test           # the engine
npm run typecheck
npm run build      # static bundle in apps/web/dist
```

## What it does that other trackers don't

**System load.** On weighted pull-ups and dips it tracks `bodyweight + added
weight`, not belt weight. During a lean gain, +45 lb at 132 lb bodyweight and
+45 lb at 142 lb are ten pounds apart in real work, and belt weight alone makes
genuine progress look like a plateau. When bodyweight is unknown the app prints
`—` rather than a number that would read as a plateau.

**An energy density constant that isn't 3500.** 3500 kcal/lb is body fat. Tissue
gained on a lean gain is a mix, and using the textbook number overfeeds by
roughly 200 kcal/day. [Why this matters](packages/engine#1-the-energy-density-constant-is-not-3500).

**Separate expenditure for active and rest days.** A standing shift can run
300-500 kcal above an off day. Eating one flat number means a surplus on half of
them.

**An engine that refuses to guess.** Nine hard guardrails, an explicit confidence
model, and a rule that no calorie change happens unless a plain-English reason
for it can be generated.

## The logger

One screen per lift, sized so nothing scrolls while a set is in progress.

- **The prescription before the set, not after.** Double progression, computed
  from the last two sessions: all sets at the top of the range adds an
  increment, otherwise chase reps at the same load, and two flat transitions in
  a row reports a stall — with the sentence explaining which it did and why.
- **Last session's numbers** on screen while you log this one.
- **System load** on the same row as belt weight, so the column that matters is
  the one you can see moving.
- **Rest timer** driven by wall-clock time, so a phone locked in a pocket does
  not come back thirty seconds slow.
- **Deload** as a toggle: halves the sets, drops to ~87.5%, strips the belt from
  bodyweight-loaded lifts. A banner suggests one when the schedule expires or
  two independent fatigue signals appear.
- **JSON export and import.** There is no server, so the export file is the only
  backup that exists, and it round-trips through the same Zod schemas the engine
  uses.

Everything derived — system load, prescriptions, weekly volume — is computed at
read time and never stored. A corrected bodyweight fixes every system load that
depended on it.

## Deploying it

Static output, no server side, so anything that serves files will do.

- **Vercel** — [`vercel.json`](vercel.json) is at the root. Import the repo and
  accept the defaults.
- **GitHub Pages** — enable Settings → Pages → Source: GitHub Actions. The
  [workflow](.github/workflows/pages.yml) sets `BASE_PATH` to the repository
  name for you.
- **Anywhere else** — `npm run build`, serve `apps/web/dist`. Routing is
  hash-based, so no rewrite rule is needed.

Install it to a home screen and it opens like a native app and works offline,
because there is nothing to be offline from.

MIT. Not medical advice.
