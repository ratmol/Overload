# CLAUDE.md

Working agreement for this repo. Read this, then read the stage you are in.
Do not read the whole spec at the start of a session.

## What this is

`overload` — an open-source, local-first training and body-data logger with an
adaptive calorie engine that explains every number it produces.

Two products sharing a data model:

- **Product A** (`apps/web`) — the tool Adarsha uses. Boring, reliable, opens
  with one thumb mid-set. Nobody else has to like it.
- **Product B** (`packages/engine`) — the open-source portfolio piece. Pure
  functions, real tests, documented assumptions. No UI at all.

They ship on different schedules. Building them as one thing is the failure mode.

## Current stage

**Stage 3 — engine wired into the app.** Both halves are built. 252 tests
(186 engine, 66 app). The app has the training logger, the weight trend,
estimated expenditure with confidence, the target with proposals, intake import,
the weekly volume audit, and the food-logging groundwork.

`data/plan.json` is **program v2** — 75 sets a week, per-set RIR ladders,
supersets, per-exercise rest. See `PROGRAM-V2.md` one directory up. A plan
version bump now overwrites existing exercises (DECISIONS §18); it used to be
additive-only, which made v2 undeliverable.

**Two acceptance tests are still open, and neither is a coding task:**

- **Stage 1:** a full training week logged in the app with the notes app closed.
  Most likely to surface: rest timer defaults, whether the exercise rail is the
  right way to move between lifts, whether the pad survives a sweaty thumb.
- **Stage 0:** 14 days of real intake and daily weights, exported as CSV. The
  engine has never been run against real data. Every number it currently
  produces has been checked only against synthetic fixtures, which were written
  by the same person who wrote the code — that is a consistency check, not a
  validation.

Until Stage 0 lands, treat the calorie side as unvalidated regardless of how
confident the confidence model sounds.

## Rules

**Build only what the current stage needs.** The stage gate is now the two open
acceptance tests above, not a feature list. The app is ahead of its evidence:
nothing further should be added to the calorie side until real data has been
through it. Stage 4 (in-app food logging, barcode scanning) remains out.

**Engine before UI, always.** Every domain rule lands in `packages/engine` with
a test before any component renders it. If a rule cannot be tested without a
browser, it is in the wrong place. `apps/web/test` exists for the one thing that
is neither UI nor domain rule — reading someone else's CSV export.

**No number without a reason.** Every figure the app prints comes with the
engine's own reason string. If a component computes a figure itself, or renders
one the engine could not explain, that is a bug. See DECISIONS.md §15.

**Before an irreversible decision** — schema shape, storage layer, licence,
package boundary — state the tradeoff, name the alternatives, recommend one,
give the reason, and wait. Then write it into `docs/DECISIONS.md`. Everything
else, just build it.

**Priority order:** correctness > maintainability > privacy > UX > feature count.

**No analytics, no telemetry, ever.** Sync is opt-in and supersedes the older
"no server, no accounts" rule — see DECISIONS.md section 21. The app must stay
fully usable signed out, IndexedDB stays the source of truth for reads, and
nothing auth-related enters `packages/engine`.

**No AI in the calculation path.** A language model can summarise a week in
prose. It does not compute a TDEE. That boundary is the difference between a
credible tool and a toy.

**Write `docs/ALGORITHM.md` as you write the algorithm**, not afterward. The
assumptions are the interesting part and you will not remember them in a month.

**Nothing derived is stored.** systemLoad, daily totals, weekly volume, trend
values — all computed at read time. See DECISIONS.md §5.

## Skills

- `fable-mode` at session start.
- `token-optimizer` on every coding session.
- `frontend-vibe` before any UI work. Design direction is in the spec §9:
  off-white paper ground, faint graph-paper grid, ink-black text, one red accent
  reserved for the current set, tabular monospace numerals, enormous tap
  targets, nothing scrolls during an active set. **Deliberately not dark** —
  Replay is the dark project, and two dark projects make one portfolio look like
  one idea applied twice.
- `backend-quality` only if a server ever appears, which it should not.

## Commands

```bash
npm install
npm run dev               # apps/web on :5173
npm test                  # vitest, both workspaces (186 engine + 66 app)
npm run typecheck         # tsc --noEmit, strict, both workspaces
npm run build             # static bundle in apps/web/dist
BASE_PATH=/repo/ npm run build   # same build under a subpath (GitHub Pages)
```

## Layout

```
apps/web/src/
  db/             Dexie schema, queries, nutrition reads, JSON backup. The only
                  place that touches IndexedDB — components never do.
  features/       today, session, history, volume, body, data
  ui/             tokens.css, app.css
  lib/            routing, rest timer, formatting, CSV import
apps/web/test/    csv parsing, readiness thresholds, and plan.json's own claims
packages/engine/src/
  types.ts        Zod schemas. Single source of truth. No logic.
  dates.ts        UTC calendar-date arithmetic. All date math goes here.
  trend.ts        EWMA + MAD outlier downweighting + warm-up detection
  tdee.ts         Expenditure estimation, confidence, shift/off split
  adjust.ts       Calorie target adjustment + guardrails
  progression.ts  System load + double progression state machine
  deload.ts       Trigger detection
  volume.ts       Weekly hard-set audit per muscle
  food.ts         Portion maths + the foodLog/intake reconciliation seam
data/plan.json    The training program as data, not code.
docs/             ALGORITHM.md (assumptions), DECISIONS.md (ADR-lite)
```

## Things that are easy to get wrong here

**System load is the headline feature.** `bodyweight + addedWeight` on
bodyweight-loaded lifts, using the most recent **prior** weight entry, never a
later one. Returns `null` when bodyweight is unknown — show `—`, never a
silently-wrong number. Belt weight alone hides real progress during a lean gain.

**energyDensityPerLb is not 3500.** 3500 is body fat; gained tissue is a mix.
There is a test asserting the constant stays below 3500 so nobody "fixes" it.

**The trend understates the rate of gain for the first ~8 weeks.** This is a
known, documented EWMA warm-up bias, not a bug. It is guarded by `warmingUp`
(56 days = 8 half-lives), a confidence cap, AND a hard block in `adjustTarget`.
Do not "fix" it without reading ALGORITHM.md §1.1 — the naive fix makes it worse.

**Documentation is not a guardrail.** Three documents once described a
warming-up block that did not exist in `adjust.ts`, and there was no test for
it. If you write down that the engine refuses to do something, write the test in
the same commit.

**The engine must be able to say "this is not a calorie problem."** A flat trend
under a verified surplus escalates to `needs-review` and points at the blood
panel, rather than adding 100 kcal forever.

**Outlier thresholds are calibrated, not guessed.** Three constants in
`DEFAULT_TREND_OPTIONS`. Do not touch them without re-running the 25-seed tests
in `trend.test.ts`; earlier calibrations produced 12% and 5% false-flag rates.

**Every adjustment carries a reason string.** If a plain-English explanation
cannot be generated, the change does not happen.

## What not to build

A backend. Accounts or cloud sync. A food database or barcode scanner (Stage 4
at the earliest, probably never). Health Connect / Apple Health. An AI coach.
Social features, streaks, badges, gamification. A native app. A Kalman filter
before EWMA has been in daily use for a month. `repo-comparison.md`.

---

Companion documents live one directory up: `body-composition-plan.md` (what to
do) and `overload-project-spec.md` (the full spec). Neither is medical advice.
