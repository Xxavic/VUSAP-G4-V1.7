-- ============================================================================
-- Registrars see and resolve only the appeals of their own faculty.
--
-- "Admin/Registrar read all appeals" and "Admin/Registrar update appeals" let a
-- registrar of ANY faculty read and decide every faculty's appeals. This adds an
-- attendance_appeals.faculty_key column and moves both policies onto the same
-- can_write_faculty() helper the other tables use (administrator: everything;
-- registrar: their own faculty).
--
--  * The key comes from the student's own users.faculty_key, stamped by a trigger at
--    insert time, so the browser cannot choose it.
--  * Existing appeals are backfilled from the student's users row (matching
--    university_id). Any appeal that cannot be matched keeps a NULL key and is then
--    visible to administrators only - check with:
--        select count(*) from public.attendance_appeals where faculty_key is null;
--  * Students keep reading and inserting their own appeals (unchanged policies).
--
-- Needs users.faculty_key populated for students (migrate-faculty-scoped-reads.sql).
-- Idempotent.
-- ============================================================================
alter table public.attendance_appeals add column if not exists faculty_key text;

update public.attendance_appeals a
set faculty_key = u.faculty_key
from public.users u
where a.faculty_key is null
  and u.faculty_key is not null
  and u.university_id = a.student_id;

create or replace function public.stamp_appeal_faculty()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Always taken from the signed-in student's own profile; a value sent by the
  -- client is ignored. (Rows written without a session, e.g. by the service role,
  -- keep whatever they were given.)
  if auth.uid() is not null then
    new.faculty_key := (select u.faculty_key from public.users u where u.id = auth.uid());
  end if;
  return new;
end;
$$;
revoke all on function public.stamp_appeal_faculty() from public;

drop trigger if exists trg_stamp_appeal_faculty on public.attendance_appeals;
create trigger trg_stamp_appeal_faculty
  before insert on public.attendance_appeals
  for each row execute function public.stamp_appeal_faculty();

drop policy if exists "Admin/Registrar read all appeals" on public.attendance_appeals;
drop policy if exists appeals_select_faculty_staff on public.attendance_appeals;
create policy appeals_select_faculty_staff on public.attendance_appeals
  for select to authenticated
  using (public.can_write_faculty(faculty_key));

drop policy if exists "Admin/Registrar update appeals" on public.attendance_appeals;
drop policy if exists appeals_update_faculty_staff on public.attendance_appeals;
create policy appeals_update_faculty_staff on public.attendance_appeals
  for update to authenticated
  using (public.can_write_faculty(faculty_key))
  with check (public.can_write_faculty(faculty_key));
