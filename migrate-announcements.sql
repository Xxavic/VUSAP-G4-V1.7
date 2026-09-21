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
-- This policy relies on a `role` claim/column identifying each user's
-- role server-side. If your project does not already have an equivalent
-- check elsewhere (e.g. a `users` table joined on auth.uid()), adjust the
-- `from_role in (...)` condition below to match how role is actually
-- determined server-side for your schema before running this.
drop policy if exists "announcements_insert_lecturer_registrar" on public.announcements;
create policy "announcements_insert_lecturer_registrar"
  on public.announcements
  for insert
  to authenticated
  with check (
    from_supabase_id = auth.uid()
    and from_role in ('lecturer', 'registrar')
  );

-- No UPDATE/DELETE policy is created: announcements are currently
-- write-once from the app's own UI (no edit/delete flow exists yet), so
-- RLS leaves those operations denied by default (RLS enabled, no policy
-- covering them = denied) rather than silently allowing them.
