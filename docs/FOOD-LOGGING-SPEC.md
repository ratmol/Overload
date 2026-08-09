# Food logging — implementation spec

Hand this to Claude Code. It is the plan, not the code.

Scope chosen: **personal food list + barcode scanning**, over a USDA dataset
shipped as a static file. This is Stage 4 in the original spec, pulled forward
deliberately — see §0.

**Revised after reading the prior art.** The first draft of this document
proposed live USDA API calls and spent most of §5 on where to hide an API key.
OpenNutriTracker had already established that runtime FDC calls are the wrong
shape, and for a single-user app the answer is simpler still: ship the data.
§0.2 lists what changed and why.

---

## 0. Read this before writing anything

### 0.1 Why this reverses a documented decision

`overload-project-spec.md` §13 says "no food database or barcode scanner (Stage
4 at the earliest, probably never)". The reasoning was: *Cronometer already does
this well, don't rebuild it.*

That reasoning still holds for **search over 300k foods**. It does not hold for
**a list of the 40 things you actually eat**, which is a different and much
smaller product. The deciding fact is that no intake is being logged at all
right now, and the adaptive engine is inert without it. A tool you use beats a
better tool you don't.

Record this in `DECISIONS.md` as a numbered entry when you build it. Do not
quietly ignore §13 — it is a decision being reversed with a reason, which is
exactly what that file is for.

### 0.2 Prior art — read this, it changes the plan

`overload-project-spec.md` §1.4 said "fork nothing" and, in the same paragraph,
"read their architecture for ideas, which costs nothing and carries no
obligation." The first half was followed. The second half was not, and the first
draft of this spec was written from first principles as a result. Several things
below are corrections that came from actually reading the prior art.

**[OpenNutriTracker](https://github.com/simonoppowa/OpenNutriTracker)**
(GPL-3.0, Flutter, ~1.9k stars) is the closest thing to what you are building.
Its [FDC self-hosting doc](https://github.com/simonoppowa/OpenNutriTracker/blob/main/docs/supabase-fdc-self-hosting.md)
is the single most useful document for this feature and should be read before
writing code.

**Licence boundary, stated once so it is not fudged:** reading architecture,
schema shapes and lessons learned is fine and creates no obligation. Copying
their Dart source into this MIT repo would make it a derivative work. Everything
below is the former. The USDA data itself is US-government public domain, and
Open Food Facts data is ODbL — neither is affected by their GPL.

Four things they had already solved:

1. **They do not call the USDA API at runtime at all.** They pre-load a curated
   FDC subset and query that. The stated reasons are search responsiveness on
   slow connections and not needing an API key in the app. This dissolves the
   entire API-key dilemma the first draft of this spec agonised over — see §5.1.
2. **Energy nutrient preference: Atwater-specific (958) → Atwater-general (957)
   → total (1008).** The first draft said "use 1008". Theirs is better: the
   Atwater factors are food-specific, so the general/total values are cruder.
3. **Portion selection uses `measure_unit_id`** — 1049 is "serving", 9999 is
   "undetermined", 1000 is "cup". Pick 1049, else 9999, else fall back to 100 g.
   And a food can have *several* rows for the same `(fdc_id, measure_unit_id)`,
   so a composite key on those two will silently drop rows.
4. **Their verification checks, learned from being burnt:** food counts too low
   means the bulk load silently dropped malformed rows; counts wildly too high
   means Branded Foods got pulled in by accident; every food must carry at least
   one energy nutrient or it renders as 0 kcal; spot-check a known food, and if
   kcal is off by 10x or 100x it is a unit-conversion bug in the seed.

Also worth stealing from their feature list, all of which read as
learned-from-use rather than designed up front:

- **Quick add** — a title plus a kcal number, skipping search entirely. The
  escape hatch for when you know roughly what you ate.
- **Manual barcode entry** — because the camera fails often enough to need it.
- **Attach a barcode to your own custom food**, so future scans find *your*
  entry rather than a stranger's.
- **Per-meal kcal targets** with named distributions. Your plan already defines
  five slots with per-slot protein numbers; that maps onto this directly.

### 0.3 What must NOT change

- **No server.** USDA data ships as a file. Open Food Facts is called from the
  browser and only when scanning a barcode, never in the daily logging path.
  Everything else works with the network off.
- **No network in `packages/engine`.** Portion arithmetic is pure and belongs in
  the engine. `fetch` belongs in `apps/web`. If a function needs both, it is two
  functions.
- **Nothing derived is stored.** Do not store a day's calorie total. Derive it
  from the food rows every time.

---

## 1. First: the "I set up and there is nothing" problem

Diagnose before building. Ranked by likelihood:

**(a) It saved fine and every number is `—` because there is no data.** Almost
certainly this. `BodyScreen` needs weigh-ins for the trend and both weigh-ins
and intake for the estimate. With zero of each it renders `—` everywhere, and
`warmingUp` will keep it that way for eight weeks.

That is the engine behaving correctly and the product failing. A first-run
screen that says *"you have 0 of 56 days of weight history and 0 days of intake;
here is what unlocks at each threshold"* would have made it obvious. **Build
this before the food feature** — it is thirty lines and it is the difference
between "broken" and "working, waiting".

Confirm in ten seconds: DevTools → Application → IndexedDB → `overload` →
`profile`. A row there means setup saved and this is (a).

**(b) Storage was evicted.** iOS Safari deletes IndexedDB after 7 days without
interaction unless the app is installed to the home screen. If `profile` is
empty and you know you saved it, this is the cause. Fixes: install to home
screen, call `navigator.storage.persist()` on first run, and show the result
somewhere visible.

**(c) A genuine bug.** Only conclude this after (a) and (b) are ruled out. The
startup path already renders a visible error on database failure, so a blank
page would have said so.

### 1.1 Also fix while you are in there

`README.md` claims the engine has 148 tests in one place and 168 in another, and
still says a naive 3500 constant "overfeeds by roughly 200 kcal/day" — that
figure was corrected to ~95 in `ALGORITHM.md` §3.1 and the root README was
missed. Same number, three files, two values.

---

## 2. The hazard that will break this if you miss it

`IntakeEntry` currently means **one row = one day** when entered by hand, and
`logIntakeManually()` *deletes every row for that date* before inserting:

```ts
// db/nutrition.ts — current behaviour
const existing = await db.intake.where('date').equals(input.date).primaryKeys();
await db.intake.bulkDelete(existing);
await db.intake.add({ ...input, id: newId(), source: 'manual' });
```

Food logging produces **many rows per day, added incrementally**. If food rows
are written into `db.intake`, then logging breakfast and later opening the
manual-entry screen silently destroys breakfast.

**Two tables, not one.** This is the core structural decision:

| Table | Meaning | Written by |
|---|---|---|
| `foodLog` | One row per food eaten. Many per day. | The food feature |
| `intake` | One row per day-or-import-row. | CSV import, manual day entry |

Then a single function reconciles them:

```
dailyIntake(date) =
  if foodLog has rows for date  -> sum them, derive an IntakeEntry
  else                          -> whatever intake rows exist for date
```

Food logging wins where it exists, because it is the more specific record.
Everything downstream (`estimateTdee`, the dashboard) consumes the reconciled
view and never reads either table directly.

`estimateTdee` already aggregates to daily totals internally, so it needs no
change — but only if it is handed one consistent list. Do not hand it both
tables concatenated; that double-counts every day that has both.

---

## 3. Data model

New Zod schemas in `packages/engine/src/types.ts`:

```ts
FoodItem {
  id
  name                    // "Chicken breast, cooked"
  brand?                  // null for whole foods
  barcode?                // EAN/UPC, when it came from a scan
  // Per 100 g ALWAYS. One canonical basis makes portion math one line
  // instead of a unit-conversion layer.
  per100g: { kcal, proteinG, carbsG, fatG, fiberG? }
  // Named portions: "1 breast" = 174 g, "1 scoop" = 31 g.
  portions: { label: string; grams: number }[]
  source: 'usda' | 'openfoodfacts' | 'manual'
  sourceId?               // FDC id or barcode, for re-checking later
  // Which energy basis the FDC row used: Atwater-specific, Atwater-general or
  // total. Worth keeping — it is the difference between two foods' calories
  // being comparable and not, and you cannot recover it later.
  energyBasis?: 'atwater-specific' | 'atwater-general' | 'total'
  isFavourite: boolean
  lastUsedAt?             // drives most-recent-first ordering
}

FoodLogEntry {
  id
  date                    // IsoDate
  foodId
  grams                   // resolved to grams at log time
  // Snapshot of the macros AT LOG TIME. See below.
  kcal, proteinG, carbsG, fatG
  meal?: 'meal1' | 'meal2' | 'snack' | 'meal3' | 'prebed'
  loggedAt                // timestamp, for undo and ordering
}

SavedMeal {
  id
  name                    // "Meal 1"
  items: { foodId, grams }[]
}
```

**Why `FoodLogEntry` snapshots macros instead of deriving them.** This is the
one place where the project's "nothing derived is stored" rule is deliberately
broken, and the exception needs to be written down. If you correct a food's
macros later — you find the USDA entry was for raw not cooked — you must not
retroactively rewrite four months of logged days, because those days already
fed calorie decisions the engine made and explained. History is a record of what
was believed at the time. Note this in `DECISIONS.md` too.

**Seeded foods are not user foods.** The ~8,000 USDA rows live in the static
file and are read from there; only foods you have actually used or created go
into IndexedDB. Copying 8,000 rows into Dexie on first run would bloat the
database, slow the initial load, and make the next USDA refresh a migration
problem instead of a file swap.

So `FoodLogEntry.foodId` has to resolve against either source. Namespace the
ids — `usda:171077`, `off:0061719012345`, `user:<uuid>` — and have one
`lookupFood(id)` that checks the static index first and Dexie second. Doing this
on day one costs nothing; retrofitting it after four months of logs means
rewriting every row.

Dexie `version(3)`, purely additive:

```
foods:      'id, name, barcode, isFavourite, lastUsedAt'   // user + used foods only
foodLog:    'id, date, foodId, [date+meal]'
savedMeals: 'id'
```

When you log a USDA food for the first time, copy that one row into `foods` so
it survives a future rebuild of the static file. A logged food that vanishes
because USDA retired an entry is a corrupted history.

---

## 4. Engine work (pure, tested, no network)

New `packages/engine/src/food.ts`:

- `macrosForGrams(food, grams)` → scaled macros. Trivial, but it is the function
  every screen calls, so it gets tested.
- `resolvePortion(food, { portionLabel?, grams?, count? })` → grams.
- `sumFoodLog(entries)` → `{ kcal, proteinG, carbsG, fatG }`.
- `toIntakeEntry(date, entries, activityTag)` → a single `IntakeEntry` the
  existing engine already understands. **This is the seam.** Everything the
  calorie engine sees stays exactly as it is today.
- `proteinAdherence(entries, targetG)` → hit / missed, and by how much.

**Build `proteinAdherence` even though it is not glamorous.** `IntakeEntry`
already carries `proteinG` and *nothing in the engine has ever read it*. The
plan's §6 calls protein one of five non-negotiables and says missing calories is
survivable while chronically missing protein is not. It is ten lines against
data already being stored, and for someone at ALMI 7.3 it is worth more than any
refinement to the density constant.

Tests: scaling at odd gram amounts, portion resolution, a day summing to the
same total whether logged as 1 row or 12, and the reconciliation rule in §2
(food rows present → intake rows for that date ignored).

---

## 5. The APIs

### 5.1 USDA — ship the data, do not call the API

**This supersedes what an earlier draft of this spec recommended.** The first
version proposed live API calls and then spent three paragraphs on where to hide
the API key. OpenNutriTracker had already concluded that runtime FDC calls are
the wrong shape and pre-loads the data instead. They put it in Supabase because
they ship to thousands of phones and want one refreshable copy.

**You are one person. Skip the database entirely and ship the file.**

USDA publishes the whole of FoodData Central as
[downloadable CSVs](https://fdc.nal.usda.gov/download-datasets.html). Take the
two lab-analysed data types:

- **SR Legacy** — the historic reference set, roughly 7,800 foods. **Frozen**:
  the April 2018 release was declared final and will never be updated, so a
  snapshot of it cannot go stale.
- **Foundation Foods** — a few hundred entries, updated roughly twice a year.

That is around 8,000 foods. Trimmed to the six nutrients you care about — energy,
protein, fat, carbs, fibre, plus whatever else you want — and their portion rows,
it is a few MB of JSON and well under a megabyte gzipped. **Ship it as a static
asset in `apps/web/public/`.**

What that buys, all of it for free:

- No API key, so nothing to hide, no `.env`, no key-rotation story, no asterisk
  on the "no server" claim in the README.
- No rate limit. No 1,000/hour ceiling to design around.
- Search works **offline**, which the live-API version never could — and this is
  a gym-and-kitchen app where offline is the normal case.
- Instant. No spinner, no network error state, no retry logic.
- Deterministic and diffable. The food database is a file in git, so a nutrition
  number changing is a reviewable commit rather than a silent upstream edit.

Build it with a script in `tools/build-food-db.ts`, committed, so the derivation
is reproducible: download the archive, parse `food.csv`, `food_nutrient.csv` and
`food_portion.csv`, filter to your nutrient ids, emit `public/food-db.json`.
Re-run it when USDA ships a Foundation release; it is a snapshot of public data,
not a system of record, so wholesale replacement is always safe.

Do **not** include Branded Foods. It is two orders of magnitude larger, changes
constantly, and Open Food Facts covers packaged goods better anyway.

Nutrient ids to pull, per 100 g:

```
Energy   958 (Atwater specific)  ->  957 (Atwater general)  ->  1008 (total)
Protein  1003
Fat      1004
Carbs    1005
Fibre    1079
```

Take the first energy value present, in that order of preference. Some rows
carry only kJ (1062) — divide by 4.184.

**Run their verification checks after building the file**, as unit tests on the
generated artefact, not as a one-off:

- Food count in the expected low tens of thousands. Far fewer means the CSV
  parse dropped malformed rows; far more means Branded got included.
- Zero foods lacking an energy value. Any that do will render as 0 kcal.
- Spot-check "banana, raw" and "chicken breast, cooked" against known values.
  Off by 10x or 100x is a unit-conversion bug in the build script.

If you later want live search over the full 300k+ set, add it then, as an
enhancement over a working offline base. Do not start there.

### 5.2 Open Food Facts — barcode

Free, **no key, no signup**, ~4M products, good Canadian coverage.

- `GET https://world.openfoodfacts.org/api/v2/product/{barcode}.json`
- Set a `User-Agent` identifying the app — it is in their terms and they do
  throttle anonymous abuse.
- Fields: `product.nutriments` → `energy-kcal_100g`, `proteins_100g`,
  `carbohydrates_100g`, `fat_100g`. Also `product_name`, `brands`,
  `serving_quantity`.

**Crowd-sourced, so treat every field as optional.** Missing or absurd macros
are common. Validate through Zod, reject anything where the macros do not
roughly reconcile with the stated energy (4/4/9 within ~20%), and drop the user
into the manual-entry form pre-filled with whatever did parse. Never write an
unvalidated OFF payload straight to `foods`.

### 5.3 The barcode scanner itself — the constraint that will surprise you

**`BarcodeDetector` does not exist on iOS.** Every iOS browser is WebKit, and
WebKit has never shipped it. If you build against the native API it will work
on your desktop and silently fail on your phone, which is the only device that
matters here.

Use a WASM scanner — `zxing-wasm` or a ZBar build — and feed it frames from a
`getUserMedia` video element. Feature-detect `BarcodeDetector` and use it when
present (Android/Chrome, meaningfully faster), fall back to WASM otherwise.

Also: `getUserMedia` requires HTTPS. Fine on Vercel, breaks on `http://localhost`
over LAN when testing from your phone — use a tunnel or `vite --https`.

Budget the scanner as its own step. It is the highest-risk piece here and it is
optional to the core value.

---

## 6. Build order

Each step should leave the app working.

1. **First-run / progress screen** (§1). Not food work. Do it first because it
   fixes the thing that made you think the app was broken.
2. **Dexie v3 + the two-table reconciliation** (§2). No UI. Tests only. If this
   is wrong, everything above it is wrong.
3. **`packages/engine/src/food.ts` + tests** (§4), including `proteinAdherence`.
4. **`tools/build-food-db.ts` + the generated `food-db.json`** (§5.1), with the
   three verification checks as tests over the artefact. This replaces what used
   to be step 7 and moves to the front, because it turns out to be a build-time
   script rather than a runtime integration — much cheaper than it looked.
5. **Search + quick-log over the local file.** Favourites and recents first,
   portion buttons, running day total, protein as prominent as calories. Three
   taps. Undo, because mis-taps happen mid-cooking.
6. **Quick add** — title plus kcal, no search. Stolen from OpenNutriTracker.
   Ten minutes of work and it is the thing that stops you abandoning a log on a
   day you ate something you cannot be bothered to itemise.
7. **Saved meals.** Your plan already names five slots. One tap logs Meal 1.
   Probably the single highest-value screen in this document for someone eating
   a deliberately repetitive lean-gain diet.
8. **Custom foods** for the Toronto-specific brands USDA will not have — store
   whey, No Frills frozen fish, whatever skyr you buy.
9. **Open Food Facts barcode** (§5.2, §5.3), last. Include manual barcode entry
   and the ability to attach a barcode to one of your own custom foods.

**Steps 1-8 involve no network whatsoever.** The USDA data is a file in the
repo, so even "search" is offline. That is a meaningfully better position than
the first draft of this spec described, and it is entirely because the prior art
had already worked out that runtime API calls were the wrong shape.

---

## 7. Things that will be got wrong

- **Cooked vs raw.** 100 g raw chicken and 100 g cooked chicken are different
  foods with a ~30% calorie gap. USDA has both, named similarly. Put the state
  in the food's name, always, and default the seeded staples to whichever you
  actually weigh.
- **Per-100g vs per-serving.** OFF returns both, inconsistently. Store per-100g
  only, derive servings.
- **`activityTag` on food-derived days.** `IntakeEntry` requires shift or off.
  Food rows have no tag. Decide where it comes from — probably a per-day toggle
  that defaults from a weekly work pattern — and do not default it silently to
  `off`, which would bias the shift/off comparison.
- **Timezone.** A meal logged at 11pm must land on today. `dates.ts` is UTC-only
  and that is correct for the engine; the *food UI* needs local-date resolution
  at the point of capture. Get this wrong and late meals scatter across days.
- **Atwater vs total energy.** Two foods logged from different energy bases are
  not strictly comparable. It does not matter much at the scale of a daily
  total, but it is why `energyBasis` is stored — so the question is answerable
  later rather than lost.
- **Multiple portion rows for the same unit.** USDA's `food_portion.csv` can
  carry several rows with the same `(fdc_id, measure_unit_id)` and different
  gram weights. Keying on that pair silently drops rows. Use a synthetic key.
- **Don't let the daily total turn into a scold.** The number under a target is
  information. Red text and a warning icon on a day you ate 2,400 instead of
  2,550 is how people stop opening a logger. The rest of this app is deliberately
  unemotional about numbers; keep that.

---

## 8. What still should not be built

Recipe scaling. Meal planning. Photo recognition. Micronutrient tracking. An AI
that "estimates" a meal from a description — a language model guessing calories
is exactly the thing `CLAUDE.md` forbids in the calculation path, and it is
worse here than in the TDEE code because it produces a specific wrong number
that looks authoritative.
