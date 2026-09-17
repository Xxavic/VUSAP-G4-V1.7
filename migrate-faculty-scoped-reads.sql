-- Fixes a live production RLS gap: WRITE-side faculty scoping (can_write_faculty)
-- is correctly enforced on classes/programmes/faculties/sessions, but several
-- READ-side (and enrollments WRITE-side) policies use a different, unscoped
-- helper (is_admin_or_registrar / an inline role-only check) with no faculty
-- check — any Registrar can read/write every OTHER faculty's data:
--   users        SELECT "Admin/Registrar read all profiles"
--   users        UPDATE "Admin/Registrar update profiles"
--   enrollments  SELECT/INSERT/UPDATE/DELETE (all 4)
--   attendance   SELECT "Staff read all attendance"
--   attendance   UPDATE "Staff update attendance"
--   audit_log    SELECT "Admin/Registrar read audit log"
--
-- Decision: reuse can_write_faculty() for reads rather than adding a
-- can_read_faculty() — this app has no role that's read-but-not-write; an
-- Administrator always has both, a Registrar always has both scoped to
-- their own faculty. A near-duplicate function would just be a second
-- source of truth that could silently drift.
--
-- users.faculty_key is only reliably populated for Registrar rows today
-- (confirmed live: 0/6 lecturers, 1/3 students had it set). Step 1 backfills
-- it for students/lecturers from `program` (holds either a programmes.key or
-- .name — see normalizeProfile() in app.js), falling back to any class a
-- lecturer teaches. This turns the users policies back into a cheap, correct
-- plain-column check instead of a join evaluated on every row.
--
-- audit_log.target is free text with no FK (ticket-<id>/appeal-<id>/course
-- code/student reg/bare facultyKey/'system' sentinels) — not safely
-- joinable in SQL. Step 5 instead adds a faculty_key column the app
-- populates at write time using the already-trusted auditEventFacultyKey()
-- (see companion liveWriteAuditEvent() change in app.js), plus a
-- server-defaulted actor_supabase_id so "see your own actions" doesn't rely
-- on the client-supplied `actor` text (a human staffId, not a uuid, at most
-- call sites). Historical rows get NULL — fails closed for Registrars,
-- Administrators are unaffected.
--
-- Safe to run once — every policy is dropped-then-recreated, and the
-- backfill UPDATEs are guarded with `where faculty_key is null`.

-- ---------- Step 1: backfill users.faculty_key for students & lecturers ----------

-- Pass 1: resolve via the user's own `program` value, which may hold either
-- a programmes.key or a programmes.name (see normalizeProfile() in app.js).
update public.users u
set faculty_key = f.key
from public.programmes p
join public.faculties f on f.id = p.faculty_id
where u.faculty_key is null
  and u.role in ('student', 'lecturer')
  and u.program is not null
  and (u.program = p.key or u.program = p.name);

-- Pass 2: any lecturer still unresolved (no program match) — fall back to
-- any class they are teacher_id of. Deterministic pick if a lecturer spans
-- more than one faculty (rare, best-effort only).
update public.users u
set faculty_key = ranked.faculty_key
from (
  select distinct on (c.teacher_id) c.teacher_id, f.key as faculty_key
  from public.classes c
  join public.programmes p on p.id = c.programme_id
  join public.faculties f on f.id = p.faculty_id
  order by c.teacher_id, c.created_at asc
) ranked
where u.faculty_key is null
  and u.role = 'lecturer'
  and u.id = ranked.teacher_id;

-- ---------- Step 2: users — SELECT/UPDATE ----------

drop policy if exists "Admin/Registrar read all profiles" on public.users;
create policy "Admin/Registrar read all profiles"
  on public.users
  for select
  using ( can_write_faculty(users.faculty_key) );

drop policy if exists "Admin/Registrar update profiles" on public.users;
create policy "Admin/Registrar update profiles"
  on public.users
  for update
  using ( can_write_faculty(users.faculty_key) );

-- ---------- Step 3: enrollments — SELECT/INSERT/UPDATE/DELETE ----------

drop policy if exists "Admin/Registrar read all enrollments" on public.enrollments;
create policy "Admin/Registrar read all enrollments"
  on public.enrollments
  for select
  using (
    can_write_faculty((
      select f.key from public.faculties f
      join public.programmes p on p.faculty_id = f.id
      join public.classes c on c.programme_id = p.id
      where c.id = enrollments.class_id
    ))
  );

drop policy if exists "Admin/Registrar write enrollments" on public.enrollments;
create policy "Admin/Registrar write enrollments"
  on public.enrollments
  for insert
  with check (
    can_write_faculty((
      select f.key from public.faculties f
      join public.programmes p on p.faculty_id = f.id
      join public.classes c on c.programme_id = p.id
      where c.id = enrollments.class_id
    ))
  );

drop policy if exists "Admin/Registrar update enrollments" on public.enrollments;
create policy "Admin/Registrar update enrollments"
  on public.enrollments
  for update
  using (
    can_write_faculty((
      select f.key from public.faculties f
      join public.programmes p on p.faculty_id = f.id
      join public.classes c on c.programme_id = p.id
      where c.id = enrollments.class_id
    ))
  );

drop policy if exists "Admin/Registrar delete enrollments" on public.enrollments;
create policy "Admin/Registrar delete enrollments"
  on public.enrollments
  for delete
  using (
    can_write_faculty((
      select f.key from public.faculties f
      join public.programmes p on p.faculty_id = f.id
      join public.classes c on c.programme_id = p.id
      where c.id = enrollments.class_id
    ))
  );

-- ---------- Step 4: attendance — SELECT/UPDATE ----------

drop policy if exists "Staff read all attendance" on public.attendance;
create policy "Staff read all attendance"
  on public.attendance
  for select
  using (
    exists (
      select 1 from public.sessions s
      join public.classes c on c.id = s.class_id
      where s.id = attendance.session_id
        and c.teacher_id = auth.uid()
    )
    or can_write_faculty((
      select f.key from public.faculties f
      join public.programmes p on p.faculty_id = f.id
      join public.classes c on c.programme_id = p.id
      join public.sessions s on s.class_id = c.id
      where s.id = attendance.session_id
    ))
  );

drop policy if exists "Staff update attendance" on public.attendance;
create policy "Staff update attendance"
  on public.attendance
  for update
  using (
    exists (
      select 1 from public.sessions s
      join public.classes c on c.id = s.class_id
      where s.id = attendance.session_id
        and c.teacher_id = auth.uid()
    )
    or can_write_faculty((
      select f.key from public.faculties f
      join public.programmes p on p.faculty_id = f.id
      join public.classes c on c.programme_id = p.id
      join public.sessions s on s.class_id = c.id
      where s.id = attendance.session_id
    ))
  );

-- ---------- Step 5: audit_log — denormalized faculty_key + real actor id ----------

alter table public.audit_log
  add column if not exists faculty_key text,
  add column if not exists actor_supabase_id uuid references auth.users(id) default auth.uid();

drop policy if exists "Admin/Registrar read audit log" on public.audit_log;
create policy "Admin/Registrar read audit log"
  on public.audit_log
  for select
  using (
    actor_supabase_id = auth.uid()
    or can_write_faculty(faculty_key)
  );
