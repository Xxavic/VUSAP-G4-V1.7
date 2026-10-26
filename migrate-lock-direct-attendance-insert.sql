-- Stops students writing `attendance` rows directly through the API.
--
-- RUN THIS ONLY AFTER migrate-server-side-checkin.sql has been run AND a real
-- check-in (QR and PIN) has worked on a phone with the new app.js. Until
-- this is run, secrets are hidden but a student who knows the API can still
-- insert their own attendance row and skip the code check entirely.
--
-- How: a BEFORE INSERT trigger rejects an insert when the caller is a
-- signed-in STUDENT using the browser API. Inserts made inside
-- check_in_to_broadcast() run as the function owner, not as the student, so
-- they pass. Lecturers, Registrars and Administrators (corrections, the
-- no-show sweep) and the service role are untouched. This works whatever
-- the existing attendance policies are called, so no policy has to be
-- guessed at or dropped.
--
-- Side effect to expect: a phone still running an OLD cached copy of the app
-- will be refused when it tries to check in. A reload (or closing and
-- reopening the installed app) picks up the new version.
--
-- To undo:  drop trigger attendance_block_student_insert on public.attendance;
--
-- Safe to run more than once.

-- Looked up with definer rights so the answer never depends on what the
-- caller is allowed to read under row-level security.
create or replace function public.is_student_account(p_uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.users u where u.id = p_uid and u.role = 'student');
$$;
revoke all on function public.is_student_account(uuid) from public;
grant execute on function public.is_student_account(uuid) to anon, authenticated;

create or replace function public.block_student_attendance_insert()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- current_user is the database role running the statement: 'authenticated'
  -- for a browser request, the function owner inside check_in_to_broadcast().
  if current_user in ('authenticated', 'anon') and public.is_student_account(auth.uid()) then
    raise exception 'Students check in through the app, not by writing attendance directly'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists attendance_block_student_insert on public.attendance;
create trigger attendance_block_student_insert
  before insert on public.attendance
  for each row execute function public.block_student_attendance_insert();

-- Check afterwards: signed in as a student, this must be refused with 42501:
--   insert into public.attendance (session_id, student_id, status) values ('<any session id>', '<your own id>', 'present');
