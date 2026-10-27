-- Backup PIN: expires on the server, and only the lecturer can read it.
--
-- Run AFTER migrate-server-side-checkin.sql. Safe to run more than once.
--
-- Since the lecturer-controlled backup PIN (app cache qrast-v56), the app
-- hides the PIN until the lecturer generates a code, shows it for 2 minutes
-- and then swaps in a new one. That swap ran only in the lecturer's browser,
-- so a code shown just before their phone locked, closed or went offline
-- stayed valid for the rest of the session. And get_broadcast_secrets() still
-- returned the PIN to an authorized Class Coordinator, whose screen no longer
-- shows it but whose browser console could.
--
-- This file:
--   1. adds live_qr_secrets.pin_set_at, stamped by the server whenever the
--      PIN changes (the lecturer's app is unchanged)
--   2. check_in_to_broadcast(): a PIN is accepted only within 135 seconds
--      (2 minutes + 15 s grace) of pin_set_at. QR scans are unaffected.
--   3. get_broadcast_secrets(): returns the PIN only to the owning lecturer
--
-- The two functions are copied unchanged from migrate-server-side-checkin.sql
-- apart from the lines marked in comments.
--
-- Effect on offline check-ins: a PIN typed with no signal is refused if the
-- phone syncs more than 135 seconds after the code was generated. Offline
-- students should scan the QR, which is still accepted for 24 hours.
--
-- A lecturer still running an older cached app (before qrast-v56) shows one
-- PIN for the whole session; after this runs that PIN stops working 135
-- seconds after the session starts. Reopening the app fixes it.

alter table public.live_qr_secrets add column if not exists pin_set_at timestamptz;

create or replace function public.divert_broadcast_secrets()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.token is null and new.pin is null then
    return new;   -- nothing to hide (an update that does not carry secrets)
  end if;

  insert into public.live_qr_secrets as s (broadcast_id, token, pin, tokens, rotated_at, pin_set_at)
  values (new.id, new.token, new.pin,
          case when new.token is null then '{}'::text[] else array[new.token] end,
          now(),
          case when new.pin is null then null else now() end)
  on conflict (broadcast_id) do update set
    prev_token = case when excluded.token is not null and s.token is distinct from excluded.token
                      then s.token else s.prev_token end,
    rotated_at = case when excluded.token is not null and s.token is distinct from excluded.token
                      then now() else s.rotated_at end,
    tokens     = case
                   when excluded.token is null or excluded.token = any(s.tokens) then s.tokens
                   else (s.tokens || excluded.token)[greatest(1, cardinality(s.tokens) + 1 - 599):]
                 end,
    token      = coalesce(excluded.token, s.token),
    pin_set_at = case when excluded.pin is not null and s.pin is distinct from excluded.pin
                      then now() else s.pin_set_at end,
    pin        = coalesce(excluded.pin, s.pin);

  new.token := null;
  new.pin   := null;
  return new;
end;
$$;

create or replace function public.check_in_to_broadcast(
  p_broadcast_id uuid,
  p_token        text,
  p_pin          text,
  p_device_id    text,
  p_offline      boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid        uuid := auth.uid();
  v_name       text;
  v_role       text;
  b            public.live_qr_sessions%rowtype;
  sec          public.live_qr_secrets%rowtype;
  v_class_id   uuid;
  v_teacher    uuid;
  v_session_id uuid;
  v_date       date;
  v_key        text;
  v_hits       int;
  v_ok         boolean := false;
  v_row        record;
  v_marked_at  timestamptz;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  end if;

  select u.name, u.role into v_name, v_role from public.users u where u.id = v_uid;
  if not found or v_role is distinct from 'student' then
    return jsonb_build_object('ok', false, 'reason', 'not_student');
  end if;

  select * into b from public.live_qr_sessions where id = p_broadcast_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Which class is this broadcast for, and is this student in it?
  if b.class_id is not null then
    v_class_id := b.class_id;
    if not exists (select 1 from public.enrollments e where e.student_id = v_uid and e.class_id = v_class_id) then
      return jsonb_build_object('ok', false, 'reason', 'not_enrolled');
    end if;
  else
    -- Older broadcast without a class_id: use the class with this course
    -- code that the student is actually enrolled in.
    select c.id into v_class_id
    from public.classes c
    join public.enrollments e on e.class_id = c.id
    where c.code = b.course_code and e.student_id = v_uid
    limit 1;
    if v_class_id is null then
      return jsonb_build_object('ok', false, 'reason', 'not_enrolled');
    end if;
  end if;
  select c.teacher_id into v_teacher from public.classes c where c.id = v_class_id;

  -- State and age. Live check-ins need an active broadcast; a queued one
  -- may arrive after it ended, but not more than 24 hours after it began.
  if p_offline then
    if b.started_at < now() - interval '24 hours' then
      return jsonb_build_object('ok', false, 'reason', 'expired');
    end if;
  elsif not b.active then
    return jsonb_build_object('ok', false, 'reason', 'ended');
  end if;

  -- Too many wrong codes for this student on this broadcast.
  v_key := 'checkin:' || b.id::text || ':' || v_uid::text;
  select a.hits into v_hits from public.checkin_attempts a
   where a.key = v_key and a.window_start > now() - interval '10 minutes';
  if coalesce(v_hits, 0) >= 10 then
    return jsonb_build_object('ok', false, 'reason', 'locked');
  end if;

  -- Verify the code.
  select * into sec from public.live_qr_secrets where broadcast_id = b.id;
  if not found then
    sec.token := b.token;   -- nothing diverted yet (cannot normally happen after this migration)
    sec.pin   := b.pin;
    sec.tokens := '{}';
  end if;

  if coalesce(p_token, '') <> '' then
    if p_token = sec.token then
      v_ok := true;
    elsif not p_offline and p_token = sec.prev_token and sec.rotated_at > now() - interval '15 seconds' then
      v_ok := true;   -- scanned just before the QR rotated
    elsif p_offline and p_token = any(sec.tokens) then
      v_ok := true;   -- queued scan of a token that has rotated since
    end if;
  end if;
  -- A PIN only works for 2 minutes (plus 15 s for slow networks) after the
  -- lecturer's app set it. pin_set_at is null for a PIN set before
  -- migrate-backup-pin-expiry.sql ran: treated as expired.
  if not v_ok and coalesce(p_pin, '') <> '' and p_pin = sec.pin
     and sec.pin_set_at > now() - interval '135 seconds' then
    v_ok := true;
  end if;

  if not v_ok then
    insert into public.checkin_attempts as a (key, window_start, hits)
    values (v_key, now(), 1)
    on conflict (key) do update set
      hits = case when a.window_start < now() - interval '10 minutes' then 1 else a.hits + 1 end,
      window_start = case when a.window_start < now() - interval '10 minutes' then now() else a.window_start end;
    return jsonb_build_object('ok', false, 'reason', 'bad_code');
  end if;

  -- The lecture date comes from the broadcast's own (server) start time.
  v_date := (b.started_at at time zone 'UTC')::date;

  select s.id into v_session_id from public.sessions s
   where s.class_id = v_class_id and s.date = v_date
   order by s.created_at desc limit 1;
  if v_session_id is null then
    insert into public.sessions (class_id, teacher_id, topic, date)
    values (v_class_id, v_teacher, b.course_name, v_date)
    returning id into v_session_id;
  end if;

  -- What does this student already have for this lecture?
  for v_row in
    select a.id, a.live_broadcast_id, a.device_id, a.status, a.marked_at
    from public.attendance a
    where a.session_id = v_session_id and a.student_id = v_uid
  loop
    if v_row.live_broadcast_id = b.id then
      return jsonb_build_object('ok', true, 'duplicate', true,
                                'session_id', v_session_id, 'marked_at', v_row.marked_at);
    end if;
  end loop;

  select a.id, a.live_broadcast_id, a.device_id, a.status, a.marked_at into v_row
  from public.attendance a
  where a.session_id = v_session_id and a.student_id = v_uid
  order by a.marked_at desc limit 1;

  if found then
    if v_row.status = 'absent' and v_row.device_id is null then
      -- The no-show sweep marked them absent before this check-in synced.
      update public.attendance
         set status = 'present', device_id = left(p_device_id, 64), live_broadcast_id = b.id
       where id = v_row.id
       returning marked_at into v_marked_at;
      return jsonb_build_object('ok', true, 'upgraded', true,
                                'session_id', v_session_id, 'marked_at', v_marked_at);
    elsif v_row.device_id is not null then
      return jsonb_build_object('ok', false, 'reason', 'already_checked_in');
    else
      -- Staff already marked them (a correction): theirs stands.
      return jsonb_build_object('ok', true, 'duplicate', true, 'staff', true,
                                'session_id', v_session_id, 'marked_at', v_row.marked_at);
    end if;
  end if;

  begin
    insert into public.attendance (session_id, live_broadcast_id, student_id, student_name, status, device_id)
    values (v_session_id, b.id, v_uid, v_name, 'present', left(p_device_id, 64))
    returning marked_at into v_marked_at;
  exception when unique_violation then
    select a.marked_at into v_marked_at from public.attendance a
     where a.session_id = v_session_id and a.student_id = v_uid limit 1;
    return jsonb_build_object('ok', true, 'duplicate', true,
                              'session_id', v_session_id, 'marked_at', v_marked_at);
  end;

  delete from public.checkin_attempts where key = v_key;
  return jsonb_build_object('ok', true, 'duplicate', false,
                            'session_id', v_session_id, 'marked_at', v_marked_at);
end;
$$;

revoke all on function public.check_in_to_broadcast(uuid, text, text, text, boolean) from public, anon;
grant execute on function public.check_in_to_broadcast(uuid, text, text, text, boolean) to authenticated;

create or replace function public.get_broadcast_secrets(p_broadcast_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  b     public.live_qr_sessions%rowtype;
  sec   public.live_qr_secrets%rowtype;
  v_allowed boolean := false;
begin
  if v_uid is null then return null; end if;
  select * into b from public.live_qr_sessions where id = p_broadcast_id;
  if not found then return null; end if;

  if b.lecturer_id = v_uid then
    v_allowed := true;
  elsif b.active and coalesce(b.coordinator_authorized, false)
        and exists (select 1 from public.users u where u.id = v_uid and u.is_class_coordinator is true)
        and exists (
          select 1 from public.enrollments e
          where e.student_id = v_uid
            and (e.class_id = b.class_id
                 or (b.class_id is null and e.class_id in (select c.id from public.classes c where c.code = b.course_code)))
        ) then
    v_allowed := true;
  end if;
  if not v_allowed then return null; end if;

  select * into sec from public.live_qr_secrets where broadcast_id = b.id;
  if not found then return null; end if;
  -- The PIN goes only to the lecturer who owns the broadcast. A Class
  -- Coordinator gets the QR token (to display it) but never the backup PIN.
  return jsonb_build_object('token', sec.token,
                            'pin', case when b.lecturer_id = v_uid then sec.pin end);
end;
$$;

revoke all on function public.get_broadcast_secrets(uuid) from public, anon;
grant execute on function public.get_broadcast_secrets(uuid) to authenticated;

-- Checks (run after):
--   1. The column exists (one row):
--        select column_name from information_schema.columns
--        where table_name = 'live_qr_secrets' and column_name = 'pin_set_at';
--   2. Lecturer: start a session, tap Generate backup code. A student enters
--      it within 2 minutes: checked in.
--   3. Generate a code, lock the lecturer's phone for 3 minutes, then a
--      student enters that code: "That code didn't match".
--   4. Class Coordinator with display authorized: QR shows and rotates. From
--      the browser console, supabase.rpc('get_broadcast_secrets', ...) returns
--      a token and "pin": null.
