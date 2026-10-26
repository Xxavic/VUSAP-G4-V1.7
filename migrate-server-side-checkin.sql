-- Server-side check-in verification (Oct 2026).
--
-- THE PROBLEM THIS CLOSES
-- Until now the rotating QR token and the 6-digit PIN lived in plain
-- columns on `live_qr_sessions`, a table every signed-in student can read,
-- and the student's own phone compared what they scanned/typed against
-- those values and then inserted its own `attendance` row. So anyone who
-- opened devtools could read the token and PIN of a lecture they were not
-- in, and mark themselves present from home.
--
-- WHAT THIS DOES
-- 1. Secrets move to `live_qr_secrets`, which no student (or anyone via the
--    API) can read. A BEFORE trigger on `live_qr_sessions` diverts `token`
--    and `pin` into it on every insert/update and leaves NULL in the
--    public row, so the app's existing broadcast writes keep working
--    unchanged and Realtime never carries a secret to a student's phone.
-- 2. `check_in_to_broadcast()` is the only way a student records presence:
--    it checks the signed-in student, their enrollment, the broadcast, the
--    code (QR token or PIN) and a failed-attempt limit, derives the
--    lecture date from the broadcast's own server start time, and writes
--    the row. Nothing the phone says about dates or sessions is trusted.
-- 3. `get_broadcast_secrets()` hands the token/PIN back to the lecturer who
--    owns the broadcast, and to a Class Coordinator only while the lecturer
--    has authorized display.
--
-- OFFLINE CHECK-INS
-- A queued check-in is verified the same way when it syncs, with two
-- differences: the broadcast may already have ended, and the QR token may
-- be any token that broadcast issued (it has rotated since). The broadcast
-- must be less than 24 hours old (server clock), exist, and match the
-- class. The phone's clock is not used for anything.
--
-- DEPLOY ORDER (important)
-- 1. Deploy the updated app.js first. It detects that this migration is
--    missing and keeps working the old way until it is run.
-- 2. Run THIS file. From that moment secrets are hidden and check-ins are
--    verified on the server.
-- 3. Test a real check-in on a phone (QR and PIN, online and offline).
-- 4. Only then run migrate-lock-direct-attendance-insert.sql, which stops
--    students inserting `attendance` rows directly through the API.
--    Without step 4 a determined student can still skip the check by
--    writing their own row, so do not skip it.
--
-- Safe to run more than once.

-- ---------- 1. Secrets table ----------

create table if not exists public.live_qr_secrets (
  broadcast_id uuid primary key
    references public.live_qr_sessions(id) on delete cascade
    deferrable initially deferred,   -- the trigger below runs BEFORE the broadcast row exists
  token        text,
  prev_token   text,
  rotated_at   timestamptz not null default now(),
  tokens       text[] not null default '{}',   -- every token this broadcast has issued (capped), for offline check-ins
  pin          text
);

alter table public.live_qr_secrets enable row level security;
-- No policies on purpose: nobody can read or write this table through the
-- API. Only the SECURITY DEFINER functions below touch it.
revoke all on public.live_qr_secrets from anon, authenticated;

-- The public broadcast row no longer needs to hold the secrets.
alter table public.live_qr_sessions alter column token drop not null;
alter table public.live_qr_sessions alter column pin   drop not null;

-- ---------- 2. Divert secrets on every write ----------

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

  insert into public.live_qr_secrets as s (broadcast_id, token, pin, tokens, rotated_at)
  values (new.id, new.token, new.pin,
          case when new.token is null then '{}'::text[] else array[new.token] end,
          now())
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
    pin        = coalesce(excluded.pin, s.pin);

  new.token := null;
  new.pin   := null;
  return new;
end;
$$;

drop trigger if exists live_qr_sessions_divert_secrets on public.live_qr_sessions;
create trigger live_qr_sessions_divert_secrets
  before insert or update on public.live_qr_sessions
  for each row execute function public.divert_broadcast_secrets();

-- Move whatever is already sitting in the public rows (including any live
-- session right now), then blank it. The no-op update fires the trigger.
insert into public.live_qr_secrets (broadcast_id, token, pin, tokens)
select id, token, pin, case when token is null then '{}'::text[] else array[token] end
from public.live_qr_sessions
where token is not null or pin is not null
on conflict (broadcast_id) do nothing;

update public.live_qr_sessions set token = null, pin = null
where token is not null or pin is not null;

-- ---------- 3. Failed-attempt limit ----------

create table if not exists public.checkin_attempts (
  key          text primary key,
  window_start timestamptz not null default now(),
  hits         int not null default 0
);
alter table public.checkin_attempts enable row level security;
revoke all on public.checkin_attempts from anon, authenticated;

-- ---------- 4. The check-in ----------
-- Returns jsonb: {"ok":true, ...} or {"ok":false,"reason":"<code>"}.
-- Reason codes: not_signed_in, not_student, not_found, not_enrolled, ended,
-- expired, locked, bad_code, already_checked_in.

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
  if not v_ok and coalesce(p_pin, '') <> '' and p_pin = sec.pin then
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

-- ---------- 5. Giving the secrets back to who needs them ----------
-- The owning lecturer (to resume a session after a reload) and a Class
-- Coordinator while the lecturer has authorized display. Returns NULL for
-- anyone else.

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
  return jsonb_build_object('token', sec.token, 'pin', sec.pin);
end;
$$;

revoke all on function public.get_broadcast_secrets(uuid) from public, anon;
grant execute on function public.get_broadcast_secrets(uuid) to authenticated;

-- ---------- Checks you can run afterwards ----------
-- (a) No secret left in the public table (should return 0):
--   select count(*) from public.live_qr_sessions where token is not null or pin is not null;
-- (b) Secrets are held privately (one row per broadcast):
--   select count(*) from public.live_qr_secrets;
-- (c) A student cannot read them: signed in as a student, this must fail or
--     return nothing:   select * from public.live_qr_secrets;
