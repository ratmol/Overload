-- overload — initial sync schema
--
-- Run this in the Supabase SQL editor, or `supabase db push` if you use the CLI.
--
-- Two things in here are load-bearing and easy to get wrong:
--
--   1. ROW LEVEL SECURITY. Without it, the project URL plus the anon key —
--      which ships in the browser bundle by design — gives anyone every row in
--      this database. That is the only mistake in this file that is a privacy
--      incident rather than a bug. Every table below enables RLS and has a
--      policy; there are no exceptions and there must never be one.
--
--   2. `deleted_at`. A hard DELETE cannot sync. The other device has no way to
--      tell "deleted elsewhere" from "not uploaded yet", so it re-uploads the
--      row and the deletion undoes itself. Deletes are soft, everywhere.
--
-- `updated_at` is set by a trigger, never by the client. A phone with a wrong
-- clock must not be able to win last-write-wins forever.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
--
-- Ids are client-generated UUIDs. The primary key is (user_id, id) rather than
-- id alone so that two users cannot collide even in principle — with RLS in
-- place a collision would present as a row that exists but cannot be read,
-- which is a miserable thing to debug.
--
-- NOT SYNCED, deliberately: exercises, templates, plan.
-- Those are seeded identically on every device from data/plan.json, and
-- DECISIONS.md §18 has a migration that OVERWRITES them on a plan version bump.
-- Syncing them means two devices on different app versions fight forever, one
-- pushing v3 rows and the other pushing v2. They stay local until the program
-- is per-user rather than global. See DECISIONS.md §21.

create table if not exists public.sessions (
  user_id       uuid        not null references auth.users on delete cascade,
  id            text        not null,
  date          date        not null,
  template_id   text        not null,
  is_deload     boolean     not null default false,
  sleep_quality int,
  joint_pain_flag boolean,
  resting_hr_bpm  int,
  dread_flag    boolean,
  swaps         jsonb       not null default '{}'::jsonb,
  supersets_off boolean     not null default false,
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  primary key (user_id, id)
);

create table if not exists public.sets (
  user_id        uuid        not null references auth.users on delete cascade,
  id             text        not null,
  session_id     text        not null,
  exercise_id    text        not null,
  added_weight_lb numeric    not null,
  reps           int         not null,
  rir            numeric     not null,
  is_warmup      boolean     not null default false,
  performed_at   timestamptz not null,
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  primary key (user_id, id)
);

create table if not exists public.weights (
  user_id        uuid        not null references auth.users on delete cascade,
  id             text        not null,
  date           date        not null,
  weight_lb      numeric     not null,
  source         text        not null,
  flagged_outlier boolean    not null default false,
  note           text,
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  primary key (user_id, id)
);

create table if not exists public.intake (
  user_id     uuid        not null references auth.users on delete cascade,
  id          text        not null,
  date        date        not null,
  calories    numeric     not null,
  protein_g   numeric     not null,
  carbs_g     numeric     not null,
  fat_g       numeric     not null,
  source      text        not null,
  activity_tag text       not null,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (user_id, id)
);

create table if not exists public.adjustments (
  user_id         uuid        not null references auth.users on delete cascade,
  id              text        not null,
  date            date        not null,
  previous_target numeric     not null,
  new_target      numeric     not null,
  reason          text        not null,
  confidence      text        not null,
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  primary key (user_id, id)
);

create table if not exists public.foods (
  user_id      uuid        not null references auth.users on delete cascade,
  id           text        not null,
  name         text        not null,
  brand        text,
  barcode      text,
  per_100g     jsonb       not null,
  portions     jsonb       not null default '[]'::jsonb,
  source       text        not null,
  source_id    text,
  is_favourite boolean     not null default false,
  last_used_at timestamptz,
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  primary key (user_id, id)
);

create table if not exists public.food_log (
  user_id    uuid        not null references auth.users on delete cascade,
  id         text        not null,
  date       date        not null,
  food_id    text        not null,
  grams      numeric     not null,
  kcal       numeric     not null,
  protein_g  numeric     not null,
  carbs_g    numeric     not null,
  fat_g      numeric     not null,
  meal       text,
  logged_at  timestamptz not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, id)
);

create table if not exists public.saved_meals (
  user_id    uuid        not null references auth.users on delete cascade,
  id         text        not null,
  name       text        not null,
  items      jsonb       not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, id)
);

-- Single-row-per-user tables. These are the ones that are actually EDITED on
-- both devices, so they are where last-write-wins can genuinely lose an edit.
-- The app surfaces a remote overwrite on these two rather than applying it
-- silently.

create table if not exists public.profile (
  user_id     uuid        not null references auth.users on delete cascade,
  id          text        not null,
  height_cm   numeric     not null,
  birth_year  int         not null,
  unit_preference text    not null,
  goal_type   text        not null,
  target_rate_band_lb_per_week jsonb not null,
  energy_density_override numeric,
  calories_locked boolean not null default false,
  min_target_kcal numeric,
  medical_screen_completed_date date,
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  primary key (user_id, id)
);

create table if not exists public.target (
  user_id       uuid        not null references auth.users on delete cascade,
  id            text        not null,
  current_kcal  numeric     not null,
  baseline_kcal numeric     not null,
  last_adjustment_date date,
  consecutive_unresponsive int not null default 0,
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  primary key (user_id, id)
);

-- ---------------------------------------------------------------------------
-- Row level security, updated_at triggers, and the pull index
-- ---------------------------------------------------------------------------
--
-- Applied in a loop so a table added later cannot quietly miss one. Adding a
-- table to this list is the ONLY supported way to add a synced table.

do $$
declare
  t text;
  synced_tables text[] := array[
    'sessions', 'sets', 'weights', 'intake', 'adjustments',
    'foods', 'food_log', 'saved_meals', 'profile', 'target'
  ];
begin
  foreach t in array synced_tables loop
    execute format('alter table public.%I enable row level security', t);

    -- Force RLS so even the table owner is subject to it. Without this a
    -- privileged connection silently bypasses every policy above.
    execute format('alter table public.%I force row level security', t);

    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format($f$
      create policy "own rows" on public.%I
        for all to authenticated
        using (auth.uid() = user_id)
        with check (auth.uid() = user_id)
    $f$, t);

    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format($f$
      create trigger set_updated_at before update on public.%I
        for each row execute function public.set_updated_at()
    $f$, t);

    -- The pull query is "everything of mine changed since X", so this is the
    -- only index that matters.
    execute format(
      'create index if not exists %I on public.%I (user_id, updated_at)',
      t || '_user_updated_idx', t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Verification — run this after the migration, and again after any change
-- ---------------------------------------------------------------------------
--
-- Every synced table must appear with rowsecurity = true, forcerowsecurity =
-- true, and exactly one policy. Anything else is a hole.
--
--   select c.relname,
--          c.relrowsecurity  as rls_enabled,
--          c.relforcerowsecurity as rls_forced,
--          count(p.polname)  as policies
--     from pg_class c
--     join pg_namespace n on n.oid = c.relnamespace
--     left join pg_policy p on p.polrelid = c.oid
--    where n.nspname = 'public' and c.relkind = 'r'
--    group by 1, 2, 3
--    order by 1;
--
-- Then do the test that actually matters, which no query can do for you: sign
-- in as a SECOND account and confirm you cannot read the first account's rows.
