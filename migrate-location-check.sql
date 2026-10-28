-- ============================================================================
-- In-room location check, phase 1: FLAG, never block.  (Off by default.)
--
-- See IN-ROOM-CHECK.md. When an administrator switches it on (Attendance Rules ->
-- Policies), the lecturer's phone shares its position once when a session starts and
-- each student's phone shares its position once, right after a successful live
-- check-in. The server works out the distance and, if the student is further away
-- than the radius (allowing for GPS accuracy), adds a "medium" entry to the fraud log
-- for the registrar to review. NOBODY IS EVER REFUSED a check-in because of this.
--
-- Privacy by design:
--   * A student's coordinates are NEVER stored - only the resulting distance in metres
--     and the phone's reported accuracy.
--   * The lecturer's start position sits in live_qr_locations, which no signed-in user
--     can read directly (row-level security with no policies); only the functions
--     below use it.
--   * attendance_locations (distance only) is readable by registrars and administrators.
--   * purge_checkin_locations(days) deletes old rows; run it on a schedule or by hand.
--   * Offline (queued) check-ins are never located: the phone is not in the room when
--     they sync, so the position would be meaningless.
--
-- Idempotent. Needs migrate-server-side-checkin.sql (live_qr_sessions, attendance).
-- ============================================================================

-- ---- settings: default OFF ----
alter table public.system_settings
  add column if not exists location_check_mode text not null default 'off',
  add column if not exists location_check_radius_m integer not null default 150;
alter table public.system_settings drop constraint if exists system_settings_location_mode_chk;
alter table public.system_settings add constraint system_settings_location_mode_chk
  check (location_check_mode in ('off', 'flag'));
alter table public.system_settings drop constraint if exists system_settings_location_radius_chk;
alter table public.system_settings add constraint system_settings_location_radius_chk
  check (location_check_radius_m between 50 and 2000);

-- ---- where the lecturer started the session (not readable by clients) ----
create table if not exists public.live_qr_locations (
  broadcast_id uuid primary key references public.live_qr_sessions(id) on delete cascade,
  lecturer_id  uuid not null,
  lat          double precision not null,
  lng          double precision not null,
  accuracy_m   double precision,
  created_at   timestamptz not null default now()
);
alter table public.live_qr_locations enable row level security;   -- no policies: locked

-- ---- how far each student was (distance only, never coordinates) ----
create table if not exists public.attendance_locations (
  attendance_id uuid primary key references public.attendance(id) on delete cascade,
  broadcast_id  uuid not null,
  student_id    uuid not null,
  distance_m    integer,            -- null = the student did not share a location
  accuracy_m    integer,
  flagged       boolean not null default false,
  created_at    timestamptz not null default now()
);
alter table public.attendance_locations enable row level security;
drop policy if exists attendance_locations_select_staff on public.attendance_locations;
create policy attendance_locations_select_staff on public.attendance_locations
  for select to authenticated
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.role in ('registrar', 'administrator')));

-- fraud_logs.reported_by comes from migrate-tighten-inserts.sql; make sure it exists.
alter table public.fraud_logs add column if not exists reported_by uuid default auth.uid();

-- Great-circle distance in metres.
create or replace function public.haversine_m(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision
language sql immutable
as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  ))
$$;

-- ---- the lecturer's phone reports where the session started ----
create or replace function public.set_session_location(
  p_broadcast_id uuid, p_lat double precision, p_lng double precision, p_accuracy double precision default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid(); v_mode text;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;
  select location_check_mode into v_mode from public.system_settings where id = 1;
  if coalesce(v_mode, 'off') = 'off' then return jsonb_build_object('ok', true, 'skipped', true); end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    return jsonb_build_object('ok', false, 'reason', 'bad_position');
  end if;
  if not exists (select 1 from public.live_qr_sessions b where b.id = p_broadcast_id and b.lecturer_id = v_uid) then
    return jsonb_build_object('ok', false, 'reason', 'not_your_session');
  end if;
  insert into public.live_qr_locations (broadcast_id, lecturer_id, lat, lng, accuracy_m)
  values (p_broadcast_id, v_uid, p_lat, p_lng, p_accuracy)
  on conflict (broadcast_id) do update
    set lat = excluded.lat, lng = excluded.lng, accuracy_m = excluded.accuracy_m, created_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

-- ---- a student's phone reports where it was at check-in ----
-- Call right after a successful LIVE check-in. p_lat/p_lng may be null (denied or
-- unavailable): that is recorded as "no location" and never flagged.
create or replace function public.record_checkin_location(
  p_broadcast_id uuid, p_lat double precision, p_lng double precision, p_accuracy double precision default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_mode     text;
  v_radius   integer;
  v_att      uuid;
  v_loc      public.live_qr_locations%rowtype;
  v_dist     double precision;
  v_slack    double precision;
  v_flag     boolean := false;
  v_name     text;
  v_course   text;
  v_device   text;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not_signed_in'); end if;

  select location_check_mode, location_check_radius_m into v_mode, v_radius from public.system_settings where id = 1;
  if coalesce(v_mode, 'off') = 'off' then return jsonb_build_object('ok', true, 'skipped', true); end if;

  -- Only for a check-in this student really made on this broadcast.
  select a.id, a.device_id into v_att, v_device from public.attendance a
   where a.live_broadcast_id = p_broadcast_id and a.student_id = v_uid limit 1;
  if v_att is null then return jsonb_build_object('ok', false, 'reason', 'no_checkin'); end if;

  select * into v_loc from public.live_qr_locations where broadcast_id = p_broadcast_id;
  if not found then return jsonb_build_object('ok', true, 'skipped', true, 'reason', 'no_lecturer_position'); end if;

  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    insert into public.attendance_locations (attendance_id, broadcast_id, student_id, distance_m, accuracy_m, flagged)
    values (v_att, p_broadcast_id, v_uid, null, null, false)
    on conflict (attendance_id) do nothing;
    return jsonb_build_object('ok', true, 'located', false);
  end if;

  v_dist  := public.haversine_m(v_loc.lat, v_loc.lng, p_lat, p_lng);
  -- GPS indoors is rough: forgive up to 300 m of reported error from each phone.
  v_slack := least(coalesce(p_accuracy, 0), 300) + least(coalesce(v_loc.accuracy_m, 0), 300);
  v_flag  := (v_dist - v_slack) > coalesce(v_radius, 150);

  insert into public.attendance_locations (attendance_id, broadcast_id, student_id, distance_m, accuracy_m, flagged)
  values (v_att, p_broadcast_id, v_uid, round(v_dist)::int, round(coalesce(p_accuracy, 0))::int, v_flag)
  on conflict (attendance_id) do nothing;

  if v_flag then
    select u.name into v_name from public.users u where u.id = v_uid;
    select b.course_code into v_course from public.live_qr_sessions b where b.id = p_broadcast_id;
    insert into public.fraud_logs (student, reason, severity, course, device_id, reported_by)
    values (coalesce(v_name, 'Unknown'),
            'Checked in about ' || round(v_dist)::int || ' m from the lecturer (limit ' || coalesce(v_radius, 150) || ' m)',
            'medium', v_course, v_device, v_uid);
  end if;
  return jsonb_build_object('ok', true, 'located', true, 'flagged', v_flag);
end;
$$;

-- ---- retention ----
create or replace function public.purge_checkin_locations(p_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer; m integer;
begin
  if not exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'administrator') then
    raise exception 'administrators only';
  end if;
  delete from public.attendance_locations where created_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics n = row_count;
  delete from public.live_qr_locations where created_at < now() - make_interval(days => greatest(p_days, 1));
  get diagnostics m = row_count;
  return n + m;
end;
$$;

revoke all on function public.set_session_location(uuid, double precision, double precision, double precision) from public, anon;
revoke all on function public.record_checkin_location(uuid, double precision, double precision, double precision) from public, anon;
revoke all on function public.purge_checkin_locations(integer) from public, anon;
grant execute on function public.set_session_location(uuid, double precision, double precision, double precision) to authenticated;
grant execute on function public.record_checkin_location(uuid, double precision, double precision, double precision) to authenticated;
grant execute on function public.purge_checkin_locations(integer) to authenticated;
