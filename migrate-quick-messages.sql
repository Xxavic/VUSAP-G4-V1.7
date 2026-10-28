-- Quick messages: reusable wording for the Send screen (Oct 2026).
--
-- Until now these lived only in the app's memory, so an Administrator's edits
-- vanished on reload and were never seen by lecturers or registrars. They are
-- now shared, organisation-wide wording:
--   * lecturers, registrars and administrators can read them (to use them);
--   * only an Administrator can add, change or remove them.
-- The six built-in messages are added once, if the table is empty.
--
-- Safe to run more than once.

create table if not exists public.quick_messages (
  id          uuid primary key default gen_random_uuid(),
  label       text not null check (char_length(btrim(label)) between 1 and 60),
  title       text not null check (char_length(btrim(title)) between 1 and 160),
  body        text not null check (char_length(btrim(body)) between 1 and 2000),
  sort_order  int  not null default 100,
  created_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

alter table public.quick_messages enable row level security;

drop policy if exists "quick_messages_select_staff" on public.quick_messages;
create policy "quick_messages_select_staff"
  on public.quick_messages for select to authenticated
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.role in ('lecturer', 'registrar', 'administrator')));

drop policy if exists "quick_messages_insert_admin" on public.quick_messages;
create policy "quick_messages_insert_admin"
  on public.quick_messages for insert to authenticated
  with check (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'administrator'));

drop policy if exists "quick_messages_update_admin" on public.quick_messages;
create policy "quick_messages_update_admin"
  on public.quick_messages for update to authenticated
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'administrator'))
  with check (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'administrator'));

drop policy if exists "quick_messages_delete_admin" on public.quick_messages;
create policy "quick_messages_delete_admin"
  on public.quick_messages for delete to authenticated
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'administrator'));

-- The built-in messages, once.
insert into public.quick_messages (label, title, body, sort_order)
select v.label, v.title, v.body, v.sort_order
from (values
  ('Class cancelled', 'Class cancelled: [course] on [date]', 'The [course] class on [date] at [time] is cancelled. We will share the make-up arrangements soon. Sorry for the inconvenience.', 1),
  ('Class rescheduled', 'Class moved: [course]', 'The [course] class that was on [old date] has moved to [new date] at [time], venue [venue]. Please note the change.', 2),
  ('Attendance reminder', 'Reminder: attendance counts', 'A reminder that you need at least 75% attendance to qualify for exams. Check in at the start of every lecture and check your attendance on QRAST.', 3),
  ('Test or exam notice', '[Test/Exam]: [course] on [date]', 'The [test/exam] for [course] is on [date] at [time], venue [venue]. Arrive early and carry your student ID.', 4),
  ('Holiday or closure', 'Closed on [date]', 'The university will be closed on [date] for [reason]. Lectures resume on [date].', 5),
  ('System maintenance', 'QRAST maintenance on [date]', 'QRAST will be unavailable on [date] from [start time] to [end time] for maintenance. Please check in before or after that time.', 6)
) as v(label, title, body, sort_order)
where not exists (select 1 from public.quick_messages);

-- Check (should list 4 policies):
--   select policyname, cmd from pg_policies where tablename = 'quick_messages' order by cmd;
