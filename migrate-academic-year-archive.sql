-- Semester date ranges (System Settings) + the Academic Year Archives
-- feature (End Academic Year, past-year browsing restricted to
-- Registrar/Administrator, "Mark as Graduated") -- Chris's own policy
-- decisions, Sept 2026.
--
-- Three independent, additive changes, safe to run together in one pass:
--
-- 1. Four nullable date columns on system_settings: semester1_start,
--    semester1_end, semester2_start, semester2_end. An Administrator sets
--    these once per year in System Settings. app.js's semesterForDate()
--    is the only place that reads them, to decide which semester a given
--    attendance date actually falls in (My Students' per-student detail,
--    the Registrar's Attendance Records drilldown) instead of the old
--    behavior of labeling every record with whatever the STUDENT'S
--    profile currently says, regardless of when the record happened.
--
-- 2. New academic_year_archives table: one row per academic year an
--    Administrator or Registrar has explicitly ended (app.js's
--    endAcademicYear(), manual only -- never automatic). Nothing else is
--    ever deleted or moved when a year is archived; this is purely a
--    marker (label + period + who/when + headcounts at the time) that
--    (a) the new Academic Year Archives screen filters existing records
--    by to show a past year's full data on demand, and (b) app.js's
--    currentYearBoundary() reads to scope OTHER screens -- today, the
--    Lecturer's My Students -- to "current year only" by default. Every
--    other screen, and a student's own attendance history in particular,
--    is completely unaffected by this table's existence.
--
--    RLS mirrors migrate-system-settings.sql's pattern exactly (readable
--    by any signed-in Administrator/Registrar, since this is inherently
--    their screen -- not the "readable by anyone, writable by admin only"
--    shape system_settings uses, since this data itself is meant to be
--    Registrar/Admin-only, per Chris's own instruction).
--
-- 3. graduated_at (nullable timestamptz) on users: set only by the new
--    "Mark as Graduated" account action (a manual, per-student action --
--    see suspendAccount()'s opts.graduated in app.js), distinct from an
--    ordinary suspension so graduation is auditable/reportable on its
--    own. No RLS change needed here -- migrate-coordinator-users-columns.sql
--    already confirmed a Registrar/Administrator session can update
--    arbitrary user rows on this table.
--
-- Safe to run once. Every statement is idempotent (`if not exists` /
-- `add column if not exists` / `drop policy if exists`).

-- --- 1. Semester date ranges ---------------------------------------------

alter table public.system_settings
  add column if not exists semester1_start date,
  add column if not exists semester1_end date,
  add column if not exists semester2_start date,
  add column if not exists semester2_end date;

-- --- 2. Academic Year Archives ---------------------------------------------

create table if not exists public.academic_year_archives (
  id uuid primary key default gen_random_uuid(),
  label text not null,               -- e.g. "2025/2026" -- from system_settings.academic_year at the moment the year was ended
  period_start date,                 -- earliest semester start date configured at the time, if any (informational -- not load-bearing)
  period_end date not null,          -- the date "End Academic Year" was clicked; currentYearBoundary() anchors off this
  ended_by_name text,
  ended_by_role text,
  ended_at timestamptz not null default now(),
  student_count int,                 -- headcount at the moment of archiving (informational)
  lecturer_count int
);

alter table public.academic_year_archives enable row level security;

drop policy if exists "academic_year_archives_select_staff" on public.academic_year_archives;
create policy "academic_year_archives_select_staff"
  on public.academic_year_archives
  for select
  using (exists (select 1 from public.users where id = auth.uid() and role in ('administrator', 'registrar')));

drop policy if exists "academic_year_archives_insert_staff" on public.academic_year_archives;
create policy "academic_year_archives_insert_staff"
  on public.academic_year_archives
  for insert
  with check (exists (select 1 from public.users where id = auth.uid() and role in ('administrator', 'registrar')));

-- --- 3. Graduation marker on users ---------------------------------------------

alter table public.users
  add column if not exists graduated_at timestamptz;
