# Login and sync — implementation spec

Hand this to Claude Code. Plan, not code.

Chosen: **Supabase Auth (Google) + Postgres**, with IndexedDB kept as the local
cache. Reverses `DECISIONS.md` §2.

---

## 0. What this costs, stated before anything else

`DECISIONS.md` §2 says: *"No server, no accounts, no sync, no analytics, no
telemetry. If a task appears to need one, the task is wrong."* The README leads
with **"No server. No account. No sync. Your data stays in your browser."**

That is now false, and it was a real asset — it's the line that made the project
distinctive next to every other fitness app, and a hiring manager reading the
repo would have noticed it. Two things follow:

1. **Write a new numbered entry in `DECISIONS.md`.** Not an edit to §2 — a new
   entry that supersedes it, with the reason: two devices, no sync, data
   effectively stranded on whichever one you last used. That is a real product
   failure and it beats an architectural preference.
2. **Reframe rather than delete.** The honest new claim is *"local-first, works
   fully offline, optional sync."* That is still unusual and still true. What
   you must not do is quietly drop the old sentence and hope nobody diffs it.

**Keep IndexedDB as the source of truth for reads.** If you replace Dexie with
"fetch from Postgres on load", you lose offline, you lose instant startup, and
the gym-with-no-signal case breaks — which is the actual use case. Supabase is a
*sync target*, not a replacement.

---

## 1. Auth

Supabase Auth, Google provider. Free tier is far beyond what one user needs.

- `@supabase/supabase-js` in `apps/web` only. **Nothing auth-related goes in
  `packages/engine`** — the engine stays pure, and that boundary is what makes
  it the portfolio piece.
- Anon key ships in the bundle. That is fine and by design — it is a public
  identifier, not a secret. Row-level security is what protects the data.
- Redirect URL must be added in the Supabase dashboard for both
  `localhost:5173` and the Vercel domain. The single most common setup failure.
- **The app must remain fully usable logged out.** Sign-in is how you turn sync
  on, not a gate on the product. Someone who opens the deployed app should be
  able to log a session without an account, exactly as today.

---

## 2. Schema

Mirror the Dexie tables. Every table gets `user_id uuid` and RLS.

```sql
create table sessions (
  id          text primary key,
  user_id     uuid not null references auth.users on delete cascade,
  date        date not null,
  template_id text not null,
  is_deload   boolean not null default false,
  -- check-in fields
  sleep_quality int, joint_pain_flag boolean,
  resting_hr_bpm int, dread_flag boolean,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
-- same shape for: sets, weights, intake, adjustments, exercises,
-- templates, profile, target
```

Then, on every table:

```sql
alter table sessions enable row level security;
create policy "own rows" on sessions
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

**Get RLS right on the first migration.** Without it, one Supabase URL plus the
public anon key gives anyone every row in the database. This is the only part of
this document where a mistake is a real-world privacy incident rather than a
bug.

Two columns doing load-bearing work:

- **`updated_at`** — drives last-write-wins. Set it in a trigger, not from the
  client; a phone with a wrong clock must not be able to win a merge forever.
- **`deleted_at`** — soft delete. A hard `DELETE` cannot sync: the other device
  has no way to distinguish "row deleted elsewhere" from "row not uploaded yet",
  so it helpfully re-uploads it and the deletion undoes itself. **This is the
  single most common way a hand-rolled sync layer goes wrong.**

---

## 3. Sync

Last-write-wins per row, on `updated_at`. Do not build CRDTs.

Justification, so nobody gentrifies this later: one user, two devices, almost
never simultaneously. The realistic conflict is "logged a set on my phone at the
gym, opened the laptop that evening" — which is not a conflict, it's two
different rows. LWW on `updated_at` handles the genuine overlap correctly often
enough, and the failure mode is one lost edit, not corruption.

```
push:  local rows where updated_at > lastSyncedAt  ->  upsert
pull:  remote rows where updated_at > lastSyncedAt  ->  merge, remote wins on tie
```

Store `lastSyncedAt` in Dexie. Run on: app load, after a write settles
(debounced ~5s), and on `visibilitychange` back to visible — that last one is
what makes it feel automatic when you pick your phone up in the gym.

**The append-only tables are the easy 90%.** `sets`, `sessions`, `weights` and
`intake` are almost never edited after the fact, so LWW is nearly always
trivially right. `profile` and `target` are single-row and *are* edited — those
are where a conflict can actually bite. Consider showing the user when a remote
change overwrote a local one on those two, rather than silently applying it.

**Offline queue.** Writes go to Dexie first, always, and sync is a background
reconciliation. If the network is down the app must behave identically. Test
this by killing the network in DevTools and logging a full session — it should
be indistinguishable from online.

---

## 4. The migration that will bite you

You already have local data. On first sign-in, the app must **upload existing
local rows and attach them to the new `user_id`**, not start empty and then pull
nothing.

Get this wrong and first login looks like the app wiped your training history.
The rows are still in IndexedDB, but the user doesn't know that.

- Detect "signed in, and there are local rows with no `user_id`" → bulk upload,
  then set `lastSyncedAt`.
- **Do this once, behind a flag stored in Dexie**, or every sign-in re-uploads
  everything.
- Prompt before doing it, and export a JSON backup first. There is one copy of
  this data and the migration is the moment it is most at risk.

---

## 5. Build order

1. Supabase project, Google provider, redirect URLs. Sign in and out. No data
   yet. Confirm the app still works fully logged out.
2. Schema + RLS. **Verify RLS with a second account before writing sync code** —
   log in as B, confirm you cannot read A's rows. Do not take it on faith.
3. `updated_at` triggers and `deleted_at` on every table, local and remote.
   Soft-delete locally too, or the two halves disagree about what deletion is.
4. Push only. Local → remote. Watch rows appear in the Supabase table editor.
5. Pull + merge. Now test on two devices for real.
6. First-login migration (§4), with the backup prompt.
7. Sync status in the UI: last synced, pending count, offline. Silent sync is
   indistinguishable from broken sync, and you'll be debugging this by feel
   otherwise.

Steps 1-3 are ~an evening. Steps 4-6 are where the time actually goes.

---

## 6. Don't

- **Don't put Supabase types in `packages/engine`.** The engine takes plain
  data. Persistence is an app concern.
- **Don't sync `plan.json`-seeded exercise rows** until you've decided whether
  the program is per-user or global. Right now it's seeded identically on every
  device; syncing it creates duplicate-key headaches for no benefit.
- **Don't add realtime subscriptions.** You are not collaborating with yourself
  in real time. Sync on load and on focus is enough, and realtime is a websocket
  and a whole class of reconnection bugs.
- **Don't drop the JSON export.** It stays the backup of record. A cloud you
  don't control is not a backup, and free tiers get paused for inactivity.
