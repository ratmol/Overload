# overload

An open-source, local-first training and body-data logger with an adaptive
calorie engine that explains every number it produces.

Local-first. Works fully offline. Optional sync.

Your data lives in your browser and the app is completely usable without an
account — signing in turns sync on, it is not a gate on the product. This
supersedes an earlier "no server, no account, no sync"; see
[DECISIONS section 21](docs/DECISIONS.md) for what that cost and why.

**Status:** both halves are built and wired together. 300 tests. The app logs
training, tracks the weight trend, estimates expenditure with an explicit
confidence level, and proposes calorie changes with a written reason for each
one.

**What has not happened yet:** none of it has been run against real data. Every
number has been checked against synthetic fixtures written by the same person
who wrote the code, which is a consistency check rather than a validation. Read
the confidence model as a description of the engine's own opinion, not evidence.

| | |
|---|---|
| [`packages/engine`](packages/engine) | The adaptive engine. Pure TypeScript, 193 tests. **Start here.** |
| [`apps/web`](apps/web) | React PWA. The logger and the dashboard. |
| [`data/plan.json`](data/plan.json) | The training program as data, not code. Currently program v3 — a rolling cycle, not a fixed week. |
| [`docs/ALGORITHM.md`](docs/ALGORITHM.md) | Every constant and the assumption behind it. |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Irreversible calls and what they cost. |

```bash
npm install
npm run dev        # the app, on :5173
npm test           # 217 engine + 83 app tests
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
gained on a lean gain is a mix, and using the textbook number misattributes
roughly 95 kcal/day at a 0.35 lb/week gain. [Why this matters](packages/engine#1-the-energy-density-constant-is-not-3500).

**Separate expenditure for active and rest days.** A standing shift can run
300-500 kcal above an off day. Eating one flat number means a surplus on half of
them.

**An engine that refuses to guess.** Nine hard guardrails, an explicit confidence
model, and a rule that no calorie change happens unless a plain-English reason
for it can be generated.

## The logger

One screen per lift, sized so nothing scrolls while a set is in progress.

- **A rolling rotation, not a weekly split.** Upper A, Lower A, Upper B,
  Lower B, repeat — "next session", not "Monday's workout". A bad shift
  becomes the rest day and the queue keeps its place; there is no week to fall
  behind in. The app marks the recommended next day and nudges — never
  blocks — after two training days running, since three in a row is the one
  rule the program treats as non-negotiable.
- **The prescription before the set, not after.** Double progression, computed
  from the last two sessions: all sets at the top of the range adds an
  increment, otherwise chase reps at the same load, and two flat transitions in
  a row reports a stall — with the sentence explaining which it did and why.
- **A per-set RIR ladder.** `2 / 2 / 1` on a weighted pull-up, true failure on
  every set of a lateral raise. Failure is earned by the exercise, not by the
  lifter: a cable raise fails locally and costs a sore delt, a +70 dip fails
  systemically and bills the next 48 hours. The pad defaults to the rung for the
  set you are on, so the one hard set does not quietly become another easy one.
- **Supersets and per-exercise rest**, because a 19-set session only fits in 34
  minutes if the antagonist pairs actually fill each other's rest.
- **Last session's numbers** on screen while you log this one.
- **System load** on the same row as belt weight, so the column that matters is
  the one you can see moving.
- **Rest timer** driven by wall-clock time, so a phone locked in a pocket does
  not come back thirty seconds slow.
- **Warm-ups logged but counted nowhere** — excluded from the prescription, the
  stall detector and the volume audit. A set you did that the log denies is how
  people stop trusting a logger.
- **Swap any lift** for a curated alternate — including single-leg and
  single-arm variants of the presses, rows and leg work — when the rack is taken
  or you just are not feeling it. Swaps last one session; next week goes back to
  the programmed lift on its own. The stand-in keeps its own load history.
- **Add an exercise the library does not have.** A quick form — name, muscles
  worked, sets and rep range — reachable from the same picker as a swap. It is
  immediately swappable, searchable and loggable, through the same code path
  as every plan-seeded lift.
- **Skip a lift for today** when time or energy runs out, offered before you
  have logged anything against it. It comes back on its own next time that
  slot is due — the program is never edited, only today is.
- **Straight-sets mode** for a busy gym, which lengthens the rest rather than
  pretending a superset's 90s means the same thing run alone.
- **Type any load, rep count or RIR directly.** Steppers are right for nudging
  50 to 55 and wrong for 50 to 135.
- **Deload** as a toggle: halves the sets, drops to ~87.5%, strips the belt from
  bodyweight-loaded lifts. A banner suggests one when the schedule expires — by
  session count, not calendar weeks, since the rotation does not run on a
  fixed week either — or two independent fatigue signals appear. A four-tap
  check-in — sleep, joints,
  resting heart rate, dread — feeds the signals that fire *before* performance
  drops. The heart-rate baseline is derived from your own history, excluding the
  last two weeks, because a baseline that includes the elevation it is looking
  for can never detect it.
- **JSON export and import.** There is no server, so the export file is the only
  backup that exists, and it round-trips through the same Zod schemas the engine
  uses.

Everything derived — system load, prescriptions, weekly volume — is computed at
read time and never stored. A corrected bodyweight fixes every system load that
depended on it.

## The body side

- **Weight trend**, drawn by hand in SVG. The trend is the only continuous line
  on the chart, because a smooth curve through raw scale readings is exactly the
  false precision the EWMA exists to avoid. Downweighted outliers are drawn
  hollow — visibly still there, never deleted.
- **Estimated expenditure** as a range with a confidence level and the sentence
  explaining why the confidence landed where it did. During the first eight
  weeks it says "the trend has not settled" and refuses to act, because an
  EWMA understates the rate of gain early and the naive response — adding
  calories — is precisely backwards in month one.
- **A calorie target the engine proposes and you accept.** Nothing applies
  automatically. Blocks are shown as prominently as proposals: "not confident
  enough, because X" is the product working, not an error state.
- **Intake by CSV import** from Cronometer or MacroFactor, or by hand. Days are
  tagged shift or off, since a standing shift plausibly costs 300-500 kcal more
  than a rest day and one flat number means a surplus on half of them.
- **Weekly volume audit** against the plan's per-muscle targets, counting hard
  sets only (RIR ≤ 4) and secondaries at half.
- **A personal food list, with barcode scanning** — not a search over 300k
  foods. Scan or type a barcode, look it up against Open Food Facts, and
  every result is confirmed by hand before it is saved; crowd-sourced macros
  that do not reconcile with the stated energy are flagged rather than
  trusted. `BarcodeDetector` does not exist on iOS, so the camera path falls
  back to a WASM decoder — and a typed barcode number works regardless of
  camera support at all. See [DECISIONS §22](docs/DECISIONS.md).

No searchable food database, no AI coach, no photo recognition of a meal. The
engine's job is to explain a number, and a language model does not compute a
TDEE.

## Deploying it

Static output, no server side, so anything that serves files will do.

- **Vercel** — set **Root Directory to `apps/web`** and accept everything else.
  There are two configs, one per possible root: [`apps/web/vercel.json`](apps/web/vercel.json)
  for that setting, and [`vercel.json`](vercel.json) at the repo root for a
  project whose root is the repository itself.

  If a build ends in `No Output Directory named "dist" found`, the two disagree:
  Vercel built inside `apps/web` and then looked for the output relative to a
  different root. The Root Directory setting is what decides which config file
  Vercel reads — a config in the other folder is invisible to it.
- **GitHub Pages** — enable Settings → Pages → Source: GitHub Actions **first**,
  then run the [pages workflow](.github/workflows/pages.yml) from the Actions
  tab. It sets `BASE_PATH` to the repository name for you. It is manual-only on
  purpose: `configure-pages` fails on a repo where Pages is off, and no workflow
  can turn Pages on, so a push trigger would fail on every commit until someone
  flipped that switch by hand.
- **Anywhere else** — `npm run build`, serve `apps/web/dist`. Routing is
  hash-based, so no rewrite rule is needed.

Install it to a home screen and it opens like a native app and works offline,
because there is nothing to be offline from.

MIT. Not medical advice.
