-- =====================================================================
--  Atlas Timeclock — Supabase schema
--  Run once in Supabase → SQL Editor (new project, or a fresh schema).
--  Safe to re-run: every object is created with IF NOT EXISTS / OR REPLACE.
--
--  What lives here
--    settings              one row: company name, timezone, pay-period anchor
--    organizations         client organizations Atlas staffs
--    houses                each organization's homes, with GPS geofence
--    profiles              one per login (staff or admin), linked to auth.users
--    clock_entries         one row per shift (clock in → clock out)
--    timesheet_submissions staff sign-off for a pay period
--    period_closures       admin lock on a pay period after export
--    clock_entry_audit     append-only history of every change to a shift
--
--  Staff never write to clock_entries directly. The mobile app calls
--  clock_in() / clock_out(), which stamp the server time, match the GPS
--  point to the nearest house, and enforce the geofence rules.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
--  Tables
-- ---------------------------------------------------------------------

create table if not exists public.settings (
  id                  int primary key default 1 check (id = 1),
  company_name        text not null default 'Atlas Staffing',
  timezone            text not null default 'America/New_York',
  -- first day of any bi-weekly pay period; all periods are counted from here
  period_anchor       date not null default date '2026-09-13',
  period_length_days  int  not null default 14 check (period_length_days between 7 and 31),
  default_radius_m    int  not null default 150 check (default_radius_m between 25 and 2000),
  -- GPS fixes worse than this are refused by clock_in()/clock_out()
  max_accuracy_m      int  not null default 150 check (max_accuracy_m between 10 and 2000),
  updated_at          timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(trim(name)) > 0),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.houses (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete restrict,
  name        text not null check (length(trim(name)) > 0),
  address     text not null,
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  radius_m    int not null default 150 check (radius_m between 25 and 2000),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (org_id, name)
);

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  email       text,
  phone       text,
  role        text not null default 'staff' check (role in ('staff', 'admin')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.clock_entries (
  id              uuid primary key default gen_random_uuid(),
  staff_id        uuid not null references public.profiles(id) on delete restrict,
  house_id        uuid not null references public.houses(id)   on delete restrict,
  clock_in        timestamptz not null default now(),
  clock_out       timestamptz,
  -- clock-in fix
  in_lat          double precision,
  in_lng          double precision,
  in_accuracy_m   real,
  in_distance_m   int,
  in_inside       boolean,
  in_mocked       boolean not null default false,
  in_note         text,
  -- clock-out fix
  out_lat         double precision,
  out_lng         double precision,
  out_accuracy_m  real,
  out_distance_m  int,
  out_inside      boolean,
  out_mocked      boolean,
  out_note        text,
  -- admin
  admin_note      text,
  source          text not null default 'app' check (source in ('app', 'admin')),
  edited_by       uuid references public.profiles(id),
  edited_at       timestamptz,
  created_at      timestamptz not null default now(),
  flagged         boolean generated always as (
                    coalesce(in_inside = false, false)
                    or coalesce(out_inside = false, false)
                    or in_mocked
                    or coalesce(out_mocked, false)
                  ) stored,
  constraint clock_out_after_in check (clock_out is null or clock_out > clock_in),
  constraint shift_under_24h   check (clock_out is null or clock_out - clock_in <= interval '24 hours')
);
-- a staff member can only have one open shift
create unique index if not exists clock_entries_one_open_per_staff
  on public.clock_entries (staff_id) where clock_out is null;
create index if not exists clock_entries_clock_in_idx on public.clock_entries (clock_in);
create index if not exists clock_entries_house_idx    on public.clock_entries (house_id);

create table if not exists public.timesheet_submissions (
  staff_id      uuid not null references public.profiles(id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  total_hours   numeric(7,2) not null,
  entry_count   int not null,
  attestation   text not null,
  submitted_at  timestamptz not null default now(),
  primary key (staff_id, period_start)
);

create table if not exists public.period_closures (
  period_start  date primary key,
  period_end    date not null,
  closed_by     uuid references public.profiles(id),
  closed_at     timestamptz not null default now(),
  total_hours   numeric(9,2),
  note          text
);

create table if not exists public.clock_entry_audit (
  id          bigserial primary key,
  entry_id    uuid not null,
  action      text not null check (action in ('insert', 'update', 'delete')),
  changed_by  uuid,
  via         text not null,              -- 'app' (clock_in/out) or 'admin'
  changed_at  timestamptz not null default now(),
  old_row     jsonb,
  new_row     jsonb
);
create index if not exists clock_entry_audit_entry_idx on public.clock_entry_audit (entry_id);

-- ---------------------------------------------------------------------
--  Helpers
-- ---------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and active);
$$;

-- great-circle distance in metres
create or replace function public.distance_m(lat1 float8, lng1 float8, lat2 float8, lng2 float8)
returns float8 language sql immutable as $$
  select 2 * 6371008.8 * asin(sqrt(
           power(sin(radians(lat2 - lat1) / 2), 2)
         + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)));
$$;

-- today's date in Atlas's timezone
create or replace function public.local_today()
returns date language sql stable as $$
  select (now() at time zone (select timezone from public.settings where id = 1))::date;
$$;

-- the pay period that contains p_date
create or replace function public.pay_period_for(p_date date)
returns table (period_start date, period_end date) language sql stable as $$
  select s.period_anchor + k * s.period_length_days,
         s.period_anchor + k * s.period_length_days + s.period_length_days - 1
  from public.settings s,
       lateral (select floor((p_date - s.period_anchor)::numeric / s.period_length_days)::int as k) x
  where s.id = 1;
$$;

-- current pay period (p_offset = -1 for the previous one, etc.)
create or replace function public.pay_period(p_offset int default 0)
returns table (period_start date, period_end date) language sql stable as $$
  select pp.period_start, pp.period_end
  from public.settings s,
       lateral public.pay_period_for(public.local_today() + p_offset * s.period_length_days) pp
  where s.id = 1;
$$;

-- ---------------------------------------------------------------------
--  New auth users → profiles
--  Role comes ONLY from app_metadata (settable with the service key),
--  never from user_metadata, which anyone signing up can write.
-- ---------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email, phone, role)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), split_part(new.email, '@', 1)),
    new.email,
    new.raw_user_meta_data->>'phone',
    case when new.raw_app_meta_data->>'role' = 'admin' then 'admin' else 'staff' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
--  Clock entry guards: closed periods are read-only; admin edits stamped;
--  every change is written to the audit log.
-- ---------------------------------------------------------------------

create or replace function public.clock_entries_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_tz  text := (select timezone from public.settings where id = 1);
  v_via text := coalesce(nullif(current_setting('atlas.via', true), ''), 'admin');
begin
  if tg_op in ('UPDATE', 'DELETE') and exists (
       select 1 from public.period_closures c
       where (old.clock_in at time zone v_tz)::date between c.period_start and c.period_end) then
    raise exception 'PERIOD_CLOSED: this shift is in a closed pay period. Reopen the period to change it.';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and exists (
       select 1 from public.period_closures c
       where (new.clock_in at time zone v_tz)::date between c.period_start and c.period_end) then
    raise exception 'PERIOD_CLOSED: that date is in a closed pay period. Reopen the period first.';
  end if;
  if tg_op = 'UPDATE' and v_via = 'admin' then
    new.edited_by := auth.uid();
    new.edited_at := now();
  end if;
  if tg_op = 'INSERT' and v_via = 'admin' then
    new.source := 'admin';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists clock_entries_guard on public.clock_entries;
create trigger clock_entries_guard
  before insert or update or delete on public.clock_entries
  for each row execute function public.clock_entries_guard();

create or replace function public.clock_entries_audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.clock_entry_audit (entry_id, action, changed_by, via, old_row, new_row)
  values (
    coalesce(new.id, old.id),
    lower(tg_op),
    auth.uid(),
    coalesce(nullif(current_setting('atlas.via', true), ''), 'admin'),
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end
  );
  return null;
end;
$$;

drop trigger if exists clock_entries_audit on public.clock_entries;
create trigger clock_entries_audit
  after insert or update or delete on public.clock_entries
  for each row execute function public.clock_entries_audit();

-- ---------------------------------------------------------------------
--  Staff-facing RPCs (called by the mobile app)
-- ---------------------------------------------------------------------

-- Which house is this GPS point at? Used by the app before clock-in.
create or replace function public.locate_house(p_lat float8, p_lng float8)
returns table (house_id uuid, house_name text, org_name text, address text,
               distance_m int, radius_m int, inside boolean)
language sql stable security definer set search_path = public as $$
  select h.id, h.name, o.name, h.address,
         round(public.distance_m(p_lat, p_lng, h.lat, h.lng))::int,
         h.radius_m,
         public.distance_m(p_lat, p_lng, h.lat, h.lng) <= h.radius_m
  from public.houses h join public.organizations o on o.id = h.org_id
  where h.active and o.active and auth.uid() is not null
  order by public.distance_m(p_lat, p_lng, h.lat, h.lng)
  limit 1;
$$;

create or replace function public.clock_in(
  p_lat float8, p_lng float8, p_accuracy real,
  p_mocked boolean default false, p_note text default null)
returns public.clock_entries
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_s     public.settings;
  v_house public.houses;
  v_dist  float8;
  v_row   public.clock_entries;
begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN'; end if;
  if not exists (select 1 from public.profiles where id = v_uid and active) then
    raise exception 'ACCOUNT_INACTIVE: your account is not active. Contact your supervisor.';
  end if;
  if exists (select 1 from public.clock_entries where staff_id = v_uid and clock_out is null) then
    raise exception 'ALREADY_CLOCKED_IN: you are already on the clock.';
  end if;
  if p_lat is null or p_lng is null then
    raise exception 'LOCATION_REQUIRED: turn on location to clock in.';
  end if;

  select * into v_s from public.settings where id = 1;
  if p_accuracy is not null and p_accuracy > v_s.max_accuracy_m then
    raise exception 'LOW_ACCURACY: GPS is only accurate to % m. Step outside or wait a moment and try again.', round(p_accuracy);
  end if;

  select h.* into v_house
  from public.houses h join public.organizations o on o.id = h.org_id
  where h.active and o.active
  order by public.distance_m(p_lat, p_lng, h.lat, h.lng)
  limit 1;
  if v_house.id is null then raise exception 'NO_HOUSES: no houses are set up yet.'; end if;

  v_dist := public.distance_m(p_lat, p_lng, v_house.lat, v_house.lng);
  if v_dist > v_house.radius_m and coalesce(trim(p_note), '') = '' then
    raise exception 'OUTSIDE_GEOFENCE: you are % m from %. Add a note to clock in from here.', round(v_dist), v_house.name;
  end if;

  perform set_config('atlas.via', 'app', true);
  insert into public.clock_entries (
    staff_id, house_id, clock_in,
    in_lat, in_lng, in_accuracy_m, in_distance_m, in_inside, in_mocked, in_note)
  values (
    v_uid, v_house.id, now(),
    p_lat, p_lng, p_accuracy, round(v_dist), v_dist <= v_house.radius_m,
    coalesce(p_mocked, false), nullif(trim(p_note), ''))
  returning * into v_row;
  perform set_config('atlas.via', '', true);
  return v_row;
end;
$$;

create or replace function public.clock_out(
  p_lat float8, p_lng float8, p_accuracy real,
  p_mocked boolean default false, p_note text default null)
returns public.clock_entries
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_s     public.settings;
  v_open  public.clock_entries;
  v_house public.houses;
  v_dist  float8;
  v_row   public.clock_entries;
begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN'; end if;
  select * into v_open from public.clock_entries where staff_id = v_uid and clock_out is null;
  if v_open.id is null then raise exception 'NOT_CLOCKED_IN: you are not on the clock.'; end if;
  if now() - v_open.clock_in > interval '24 hours' then
    raise exception 'SHIFT_TOO_LONG: this shift is over 24 hours. Ask your supervisor to enter your clock-out time.';
  end if;
  if p_lat is null or p_lng is null then
    raise exception 'LOCATION_REQUIRED: turn on location to clock out.';
  end if;

  select * into v_s from public.settings where id = 1;
  if p_accuracy is not null and p_accuracy > v_s.max_accuracy_m then
    raise exception 'LOW_ACCURACY: GPS is only accurate to % m. Step outside or wait a moment and try again.', round(p_accuracy);
  end if;

  select * into v_house from public.houses where id = v_open.house_id;
  v_dist := public.distance_m(p_lat, p_lng, v_house.lat, v_house.lng);
  if v_dist > v_house.radius_m and coalesce(trim(p_note), '') = '' then
    raise exception 'OUTSIDE_GEOFENCE: you are % m from %. Add a note to clock out from here.', round(v_dist), v_house.name;
  end if;

  perform set_config('atlas.via', 'app', true);
  update public.clock_entries set
    clock_out      = now(),
    out_lat        = p_lat,
    out_lng        = p_lng,
    out_accuracy_m = p_accuracy,
    out_distance_m = round(v_dist),
    out_inside     = v_dist <= v_house.radius_m,
    out_mocked     = coalesce(p_mocked, false),
    out_note       = nullif(trim(p_note), '')
  where id = v_open.id
  returning * into v_row;
  perform set_config('atlas.via', '', true);
  return v_row;
end;
$$;

-- Staff sign-off for a pay period. Allowed from the period's last day on,
-- until an admin closes the period. Re-submitting updates the totals.
create or replace function public.submit_timesheet(p_period_start date, p_attestation text)
returns public.timesheet_submissions
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_tz    text := (select timezone from public.settings where id = 1);
  v_start date;
  v_end   date;
  v_hours numeric(7,2);
  v_count int;
  v_row   public.timesheet_submissions;
begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN'; end if;
  select period_start, period_end into v_start, v_end from public.pay_period_for(p_period_start);
  if v_start <> p_period_start then raise exception 'BAD_PERIOD: that is not the start of a pay period.'; end if;
  if public.local_today() < v_end then
    raise exception 'TOO_EARLY: you can submit this timesheet from % on.', to_char(v_end, 'Mon FMDD');
  end if;
  if exists (select 1 from public.period_closures where period_start = v_start) then
    raise exception 'PERIOD_CLOSED: this pay period has already been closed.';
  end if;
  if coalesce(trim(p_attestation), '') = '' then raise exception 'ATTESTATION_REQUIRED'; end if;
  if exists (select 1 from public.clock_entries
             where staff_id = v_uid and clock_out is null
               and (clock_in at time zone v_tz)::date between v_start and v_end) then
    raise exception 'OPEN_SHIFT: clock out of your current shift before submitting.';
  end if;

  select coalesce(round(sum(extract(epoch from (clock_out - clock_in)) / 3600.0), 2), 0), count(*)
    into v_hours, v_count
  from public.clock_entries
  where staff_id = v_uid and clock_out is not null
    and (clock_in at time zone v_tz)::date between v_start and v_end;

  insert into public.timesheet_submissions
    (staff_id, period_start, period_end, total_hours, entry_count, attestation, submitted_at)
  values (v_uid, v_start, v_end, v_hours, v_count, trim(p_attestation), now())
  on conflict (staff_id, period_start) do update set
    total_hours = excluded.total_hours, entry_count = excluded.entry_count,
    attestation = excluded.attestation, submitted_at = excluded.submitted_at
  returning * into v_row;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------
--  Views (security_invoker: callers only see rows RLS allows them)
-- ---------------------------------------------------------------------

create or replace view public.clock_entries_detail with (security_invoker = true) as
select
  e.*,
  p.full_name                                        as staff_name,
  h.name                                             as house_name,
  h.address                                          as house_address,
  h.radius_m                                         as house_radius_m,
  o.id                                               as org_id,
  o.name                                             as org_name,
  (e.clock_in at time zone s.timezone)               as clock_in_local,
  (e.clock_out at time zone s.timezone)              as clock_out_local,
  (e.clock_in at time zone s.timezone)::date         as work_date,
  case when e.clock_out is not null
       then round(extract(epoch from (e.clock_out - e.clock_in)) / 3600.0, 2) end as hours,
  pp.period_start,
  pp.period_end
from public.clock_entries e
join public.profiles      p on p.id = e.staff_id
join public.houses        h on h.id = e.house_id
join public.organizations o on o.id = h.org_id
cross join public.settings s
cross join lateral public.pay_period_for((e.clock_in at time zone s.timezone)::date) pp
where s.id = 1;

-- ---------------------------------------------------------------------
--  Row-level security
-- ---------------------------------------------------------------------

alter table public.settings              enable row level security;
alter table public.organizations         enable row level security;
alter table public.houses                enable row level security;
alter table public.profiles              enable row level security;
alter table public.clock_entries         enable row level security;
alter table public.timesheet_submissions enable row level security;
alter table public.period_closures       enable row level security;
alter table public.clock_entry_audit     enable row level security;

do $$
declare r record;
begin
  -- drop our policies so the file can be re-run cleanly
  for r in select policyname, tablename from pg_policies
           where schemaname = 'public' and policyname like 'atlas_%' loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- settings: everyone signed in reads; admins change
create policy atlas_settings_read   on public.settings for select to authenticated using (true);
create policy atlas_settings_update on public.settings for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- organizations & houses: everyone signed in reads; admins manage
create policy atlas_orgs_read  on public.organizations for select to authenticated using (true);
create policy atlas_orgs_write on public.organizations for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy atlas_houses_read  on public.houses for select to authenticated using (true);
create policy atlas_houses_write on public.houses for all    to authenticated using (public.is_admin()) with check (public.is_admin());

-- profiles: you see yourself; admins see and manage everyone
create policy atlas_profiles_read   on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
create policy atlas_profiles_update on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- clock entries: staff read their own (writes go through clock_in/clock_out);
-- admins read and correct everything
create policy atlas_entries_read  on public.clock_entries for select to authenticated using (staff_id = auth.uid() or public.is_admin());
create policy atlas_entries_insert on public.clock_entries for insert to authenticated with check (public.is_admin());
create policy atlas_entries_update on public.clock_entries for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy atlas_entries_delete on public.clock_entries for delete to authenticated using (public.is_admin());

-- submissions: staff read their own (write via submit_timesheet); admins read, and delete to reopen
create policy atlas_subs_read   on public.timesheet_submissions for select to authenticated using (staff_id = auth.uid() or public.is_admin());
create policy atlas_subs_delete on public.timesheet_submissions for delete to authenticated using (public.is_admin());

-- period closures: everyone signed in reads; admins close and reopen
create policy atlas_closures_read  on public.period_closures for select to authenticated using (true);
create policy atlas_closures_write on public.period_closures for all    to authenticated using (public.is_admin()) with check (public.is_admin());

-- audit log: admins read; nobody can change it (no insert/update/delete policies)
create policy atlas_audit_read on public.clock_entry_audit for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------
--  Function access
-- ---------------------------------------------------------------------

revoke execute on function public.clock_in(float8, float8, real, boolean, text)  from public, anon;
revoke execute on function public.clock_out(float8, float8, real, boolean, text) from public, anon;
revoke execute on function public.locate_house(float8, float8)                   from public, anon;
revoke execute on function public.submit_timesheet(date, text)                   from public, anon;
grant  execute on function public.clock_in(float8, float8, real, boolean, text)  to authenticated;
grant  execute on function public.clock_out(float8, float8, real, boolean, text) to authenticated;
grant  execute on function public.locate_house(float8, float8)                   to authenticated;
grant  execute on function public.submit_timesheet(date, text)                   to authenticated;
grant  execute on function public.pay_period(int), public.pay_period_for(date), public.local_today() to authenticated;
