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

**Stage 1 — training logger.** Engine core is built and green (108 tests).
`apps/web` is empty. Next work is Dexie schema, then the log-a-set screen.

Stage 0 (14 days of intake + daily weights via Cronometer or MacroFactor,
exported as CSV) has **not** been done. That CSV is the first real test fixture
and the engine cannot be validated against reality without it. It is a data-
collection task, not a coding task, and it runs in parallel.

## Rules

**Do not build ahead of the current stage.** While Stage 1 is open, the word
"calories" should not appear in a diff to `apps/web`.

**Engine before UI, always.** Every domain rule lands in `packages/engine` with
a test before any component renders it. If a rule cannot be tested without a
browser, it is in the wrong place.

**Before an irreversible decision** — schema shape, storage layer, licence,
package boundary — state the tradeoff, name the alternatives, recommend one,
give the reason, and wait. Then write it into `docs/DECISIONS.md`. Everything
else, just build it.

**Priority order:** correctness > maintainability > privacy > UX > feature count.

**No server, no accounts, no analytics, no telemetry.** If a task appears to
need one, the task is wrong.

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
npm test                  # vitest, packages/engine
npm run typecheck         # tsc --noEmit, strict
```

## Layout

```
packages/engine/src/
  types.ts        Zod schemas. Single source of truth. No logic.
  dates.ts        UTC calendar-date arithmetic. All date math goes here.
  trend.ts        EWMA + MAD outlier downweighting + warm-up detection
  tdee.ts         Expenditure estimation, confidence, shift/off split
  adjust.ts       Calorie target adjustment + guardrails
  progression.ts  System load + double progression state machine
  deload.ts       Trigger detection
  volume.ts       Weekly hard-set audit per muscle
apps/web/         React PWA. Empty. Stage 1 work lives here.
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
plus a confidence cap, not corrected. Do not "fix" it without reading
ALGORITHM.md §1.1 — the naive fix makes it worse.

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
