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

**Stage 3 — engine wired into the app.** Both halves are built. 307 tests
(225 engine, 82 app). The app has the training logger, the weight trend,
estimated expenditure with confidence, the target with proposals, intake import,
the weekly volume audit, sync groundwork (schema + local tracking, no client
yet), and food logging — a personal list plus barcode scanning against Open
Food Facts. See DECISIONS §16 and §22.

`data/plan.json` is **program v6** — a four-day Push / Pull / Legs /
Shoulders-Arms-Abs split. Failure training with the big compounds mixed back
in: weighted dip (Push), weighted pull-up (Pull), back squat (Legs). Every
exercise is two work sets — isolation to true failure (RIR 0), the systemic
compounds (squat, RDL, weighted pull-up/dip) capped at form-failure (RIR 1);
a deload drops both to one back-off set at RIR 4 automatically
(`deloadPrescription`, so "not to failure on a deload" needs nothing in the
data). Front delts are the priority — a dedicated DB shoulder press on both
Push and Day 4 — and abs live on Day 4. It replaced v5's 1x4 Method, which had
replaced v3's rolling Upper/Lower cycle; DECISIONS §30 has the full rationale
(§28 covers v5). §23-24 still apply — the rotation machinery is reused (4
templates, same queue logic) with a calendar-week deload since this program has
a fixed week. A plan version bump overwrites existing exercises (DECISIONS §18);
every earlier exercise stays in the library so old logged sets still resolve.

**`apps/web/test/plan.test.ts` pins v6's honest gaps, not bugs.** The PPL
structure carries no dedicated upper-chest or lat-width work, so those two
older priorities read `under` on the volume screen (~2 sets against a 6-set
floor) while front and side delts — the shoulders it actually trains — land in
range. Recorded as explicit "REGRESSION" tests — the split working as asked,
not something to quietly fix. Worth a look before assuming the volume screen
reads all green.

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
acceptance tests above, not a feature list. The app is ahead of its evidence —
food logging and barcode scanning were pulled forward at explicit request (see
DECISIONS §16, §22) despite this, which does not change the caveat below: more
inputs into an unvalidated model is not validation.

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
npm test                  # vitest, both workspaces (225 engine + 82 app)
npm run typecheck         # tsc --noEmit, strict, both workspaces
npm run build             # static bundle in apps/web/dist
BASE_PATH=/repo/ npm run build   # same build under a subpath (GitHub Pages)
```

## Layout

```
apps/web/src/
  db/             Dexie schema, queries, nutrition reads, foods, sync
                  bookkeeping, JSON backup. The only place that touches
                  IndexedDB — components never do.
  features/       today, session, history, volume, body, food, data
  ui/             tokens.css, app.css
  lib/            routing, rest timer, formatting, CSV import, Open Food
                  Facts client, barcode decoding (native + WASM fallback)
apps/web/test/    csv parsing, readiness thresholds, plan.json's own claims,
                  Open Food Facts parsing, sync bookkeeping
packages/engine/src/
  types.ts        Zod schemas. Single source of truth. No logic.
  dates.ts        UTC calendar-date arithmetic. All date math goes here.
  trend.ts        EWMA + MAD outlier downweighting + warm-up detection
  tdee.ts         Expenditure estimation, confidence, shift/off split
  adjust.ts       Calorie target adjustment + guardrails
  progression.ts  System load + double progression state machine
  deload.ts       Trigger detection
  rotation.ts     Next-in-rotation + rest-day rule for a program with no week
  session.ts      Gym-session timing: first working set -> finish, pure
  volume.ts       Weekly hard-set audit per muscle
  food.ts         Portion maths, foodLog/intake reconciliation, macro-energy
                  validation for third-party (barcode) data
data/plan.json    The training program as data, not code.
docs/             ALGORITHM.md (assumptions), DECISIONS.md (ADR-lite)
supabase/         SQL migrations. RLS-forced schema, no client wired up yet.
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

**`bulkPut` upserts, it does not replace a set.** A plan migration that drops a
template id (v3's Upper/Lower cycle, gone since v5) leaves the old row behind
forever unless the migration explicitly deletes ids that fell out of the new
plan first. See DECISIONS §31 — this is exactly the kind of thing a comment
saying "replaced, not merged" can be wrong about while the code compiles fine.

**A session row existing is not the same as training happening.** `nextInRotation`
and `accumulationSessionsSince` both key off "a session exists for this date",
so creating one just because a session screen was opened silently advances the
rotation and the deload timer. The row is created lazily, on the first actual
write (`ensureSessionId` in SessionScreen) — see DECISIONS §31.

## What not to build

A backend. Accounts or cloud sync. A food database or barcode scanner (Stage 4
at the earliest, probably never). Health Connect / Apple Health. An AI coach.
Social features, streaks, badges, gamification. A native app. A Kalman filter
before EWMA has been in daily use for a month. `repo-comparison.md`.

---

Companion documents live one directory up: `body-composition-plan.md` (what to
do) and `overload-project-spec.md` (the full spec). Neither is medical advice.
