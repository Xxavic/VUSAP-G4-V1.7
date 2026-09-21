-- Migration: announcements table + RLS
-- Purpose: backs the new live ANNOUNCEMENTS read/write wiring in app.js
-- (liveWriteAnnouncement() / loadAnnouncementsFromSupabase()). Until now
-- ANNOUNCEMENTS was entirely local-only: a Lecturer/Registrar's post lived
-- only in that one browser tab's memory and vanished on reload, and no
-- student on a different device ever saw it.
--
-- Run this in the Supabase SQL editor (or via the CLI) against your project.
-- As always: review before running -- this is delivered as a file, not
-- applied automatically.

create table if not exists public.announcements (
  id bigint generated always as identity primary key,
  from_supabase_id uuid references auth.users(id) on delete set null,
  from_name text not null,
  from_role text,
  course text,
  title text not null,
  body text not null,
  created_at timestamptz not null default now()
);

-- Helpful for the ORDER BY created_at DESC the loader uses.
create index if not exists announcements_created_at_idx
  on public.announcements (created_at desc);

alter table public.announcements enable row level security;

-- Any authenticated user (Student, Lecturer, Registrar, Administrator) can
-- read announcements -- matches the app's existing behavior where every
-- role sees the Announcements feed.
drop policy if exists "announcements_select_authenticated" on public.announcements;
create policy "announcements_select_authenticated"
  on public.announcements
  for select
  to authenticated
  using (true);

-- INSERT is restricted to Lecturer/Registrar, and only as themselves --
-- deliberately matching the UI's current capability model exactly:
-- renderAnnouncements()'s own `canPost` check is
--   State.role === 'lecturer' || State.role === 'registrar'
-- Administrator is NOT currently able to post announcements in the UI, so
-- this policy does not grant Administrator INSERT either. If that should
-- change, it needs its own explicit decision -- not a side effect of this
-- migration.
--
-- The caller's role is looked up in public.users by auth.uid() -- NEVER taken
-- from the row being inserted. from_role / from_name / from_supabase_id are
-- values the browser sends, so a policy that trusted from_role would let any
-- signed-in Student post as a Lecturer. Two layers, both server-side:
--   1. A BEFORE INSERT trigger overwrites from_supabase_id, from_role and
--      from_name from the caller's real profile, so the sender shown to
--      everyone can't be forged (whatever the client sent is ignored).
--   2. The policy independently re-checks the real role, and bounds the
--      text so this can't be used to store arbitrarily large payloads.
-- Calls with no end-user session (auth.uid() is null: the SQL editor, or an
-- Edge Function using the service role) are left untouched by the trigger.
create or replace function public.stamp_announcement_sender()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  caller record;
begin
  if auth.uid() is null then
    return new;
  end if;

  select id, name, role into caller from public.users where id = auth.uid();
  if not found then
    raise exception 'No profile for this account';
  end if;

  new.from_supabase_id := caller.id;
  new.from_role := caller.role;
  new.from_name := caller.name;
  return new;
end;
$$;

drop trigger if exists trg_stamp_announcement_sender on public.announcements;
create trigger trg_stamp_announcement_sender
  before insert on public.announcements
  for each row
  execute function public.stamp_announcement_sender();

drop policy if exists "announcements_insert_lecturer_registrar" on public.announcements;
create policy "announcements_insert_lecturer_registrar"
  on public.announcements
  for insert
  to authenticated
  with check (
    from_supabase_id = auth.uid()
    and exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.role in ('lecturer', 'registrar')
    )
    and length(title) between 1 and 200
    and length(body) between 1 and 4000
  );

-- No UPDATE/DELETE policy is created: announcements are currently
-- write-once from the app's own UI (no edit/delete flow exists yet), so
-- RLS leaves those operations denied by default (RLS enabled, no policy
-- covering them = denied) rather than silently allowing them.
