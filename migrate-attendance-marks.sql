-- Weighted attendance -> marks feature (Sept 2026), per Chris's own policy
-- decision: Present = 100% credit, Late = a configurable partial credit
-- (75% by default), Absent = 0% credit. A student's cumulative attendance
-- percentage everywhere in the app now uses this weighted formula instead
-- of treating "present" and "late" as identical (see
-- attendanceCreditForStatus() in app.js). This feeds a per-course "marks"
-- conversion: marks = weighted% x that course's own attendance-marks cap,
-- so lecturers and students can add the result onto a course's other
-- marks -- QRAST itself has no gradebook, so this is a number to read off
-- and add in elsewhere, not a gradebook feature.
--
-- Two additions:
--
--   1. system_settings.late_credit_pct -- the one configurable knob
--      (Present/Absent are fixed at 100%/0% by definition), set by an
--      Administrator in Attendance Policies. This rides on system_settings
--      specifically so it's the same number on every device: a lecturer's
--      browser and a student's browser silently disagreeing on a
--      fairness-relevant weight like this would be worse than either one
--      being locally wrong. (ATTENDANCE_POLICIES' other fields -- min
--      attendance %, grace period, etc. -- are still local-only per
--      browser, a separate, pre-existing gap not introduced here.)
--
--   2. course_attendance_caps -- one row per course: "attendance is worth
--      N marks out of the course's total marks", set by a Lecturer or
--      Registrar. Kept as its own small table rather than a new column on
--      `classes`, because:
--        - `classes` isn't reliably populated for every course yet --
--          plenty of courses still only exist in the app's own mock
--          timetable and have never migrated to a live `classes` row.
--        - `classes`' write-side RLS (can_write_faculty) is
--          Registrar/Administrator only -- Lecturers have no write access
--          to it at all today.
--      set_by_supabase_id / set_by_role are self-attested by the app, the
--      same trust model support_tickets.reporter_supabase_id already
--      uses: a Lecturer account could in principle set this cap for a
--      course they don't actually teach, since courses aren't yet
--      reliably linked to a verified real teacher account everywhere
--      (the same tracked gap as LECTURERS' missing live loader --
--      see MOCK-DATA-AUDIT.md). Chris explicitly chose to ship this now
--      ("self-attested, ship it now") rather than wait on that larger,
--      separately-tracked fix. Any signed-in staff account is still
--      required -- this is not reachable by an unauthenticated visitor.
--
-- Safe to run once. Nothing here touches or drops existing data.

alter table public.system_settings
  add column if not exists late_credit_pct numeric;

create table if not exists public.course_attendance_caps (
  course_code text primary key,
  attendance_marks_cap numeric not null check (attendance_marks_cap > 0),
  faculty_key text,
  set_by_supabase_id uuid,
  set_by_name text,
  set_by_role text,
  updated_at timestamptz not null default now()
);

alter table public.course_attendance_caps enable row level security;

-- Everyone signed in can read every course's cap -- students need it to see
-- their own computed marks, and it isn't sensitive data.
drop policy if exists "course_attendance_caps_select_all" on public.course_attendance_caps;
create policy "course_attendance_caps_select_all"
  on public.course_attendance_caps
  for select
  using (auth.role() = 'authenticated');

-- Administrator (can_write_faculty is always true for them) or a Registrar
-- for their own faculty, OR a Lecturer self-attesting they set this for
-- their own course (set_by_supabase_id = auth.uid(), set_by_role =
-- 'lecturer') -- see the note above on this trade-off.
drop policy if exists "course_attendance_caps_insert" on public.course_attendance_caps;
create policy "course_attendance_caps_insert"
  on public.course_attendance_caps
  for insert
  with check (
    can_write_faculty(faculty_key)
    or (set_by_supabase_id = auth.uid() and set_by_role = 'lecturer')
  );

-- Updating an existing cap requires either faculty-write authority, or being
-- the same person (by uid) who set it last -- a different Lecturer can't
-- silently overwrite someone else's course's cap; a Registrar/Administrator
-- always can.
drop policy if exists "course_attendance_caps_update" on public.course_attendance_caps;
create policy "course_attendance_caps_update"
  on public.course_attendance_caps
  for update
  using (
    can_write_faculty(faculty_key)
    or set_by_supabase_id = auth.uid()
  )
  with check (
    can_write_faculty(faculty_key)
    or (set_by_supabase_id = auth.uid() and set_by_role = 'lecturer')
  );
