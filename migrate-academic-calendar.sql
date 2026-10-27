-- Academic calendar: holidays, breaks, exam periods and other dated events.
--
-- Everyone signed in can read it (students and lecturers see it in the app's
-- Calendar screen). Only an Administrator can add, change or remove entries.
-- Semester start/end dates stay where they already are, in System Settings;
-- this table holds what happens inside and between them.
--
-- no_teaching = true means no lectures are expected on those dates. It is
-- what Session Delivery Rate (Lecturer Compliance) uses to leave those days
-- out of "sessions expected". A holiday or break always has it set; an exam
-- period or other event can go either way.
--
-- Safe to run more than once.

create table if not exists public.academic_calendar_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('holiday', 'break', 'exam', 'event')),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  start_date date not null,
  end_date date not null,
  no_teaching boolean not null,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint academic_calendar_dates_ordered check (end_date >= start_date),
  constraint academic_calendar_max_span check (end_date - start_date <= 366),
  constraint academic_calendar_holiday_break_no_teaching
    check (kind not in ('holiday', 'break') or no_teaching)
);

create index if not exists academic_calendar_events_start_idx
  on public.academic_calendar_events (start_date);

alter table public.academic_calendar_events enable row level security;

drop policy if exists "academic_calendar_select_authenticated" on public.academic_calendar_events;
create policy "academic_calendar_select_authenticated"
  on public.academic_calendar_events
  for select
  to authenticated
  using (true);

drop policy if exists "academic_calendar_insert_admin" on public.academic_calendar_events;
create policy "academic_calendar_insert_admin"
  on public.academic_calendar_events
  for insert
  to authenticated
  with check (exists (select 1 from public.users where id = auth.uid() and role = 'administrator'));

drop policy if exists "academic_calendar_update_admin" on public.academic_calendar_events;
create policy "academic_calendar_update_admin"
  on public.academic_calendar_events
  for update
  to authenticated
  using (exists (select 1 from public.users where id = auth.uid() and role = 'administrator'))
  with check (exists (select 1 from public.users where id = auth.uid() and role = 'administrator'));

drop policy if exists "academic_calendar_delete_admin" on public.academic_calendar_events;
create policy "academic_calendar_delete_admin"
  on public.academic_calendar_events
  for delete
  to authenticated
  using (exists (select 1 from public.users where id = auth.uid() and role = 'administrator'));

-- Check (should list 4 policies):
--   select policyname, cmd from pg_policies
--   where tablename = 'academic_calendar_events' order by cmd;
