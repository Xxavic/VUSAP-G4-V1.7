-- Fixes a live production bug: a Lecturer's "Start Live Session" never lets
-- the Lecturer's own Live Session screen show real check-ins, and (worse)
-- can silently drop a student's check-in entirely.
--
-- Root cause, confirmed directly against the live app + Supabase project:
-- liveEnsureSchedulingSession() (app.js) pre-warms today's `sessions` row
-- for the class going live, so the Lecturer's live check-in count, live
-- roster, AND the student's own attendance write (liveWriteAttendance()) all
-- have a session_id to attach to. Its SELECT works fine (confirmed live —
-- no "sessions lookup failed" warning), but its INSERT is rejected with:
--   {code: 42501, message: 'new row violates row-level security policy
--    for table "sessions"'}
-- `sessions` has row level security enabled but no INSERT policy at all, so
-- every insert is denied by default — for every role, not just Lecturer.
-- With schedulingSessionId stuck null: updateLiveCheckinCount()/
-- updateLiveRoster() both no-op (guarded on that id), so the Lecturer's
-- "X students checked in" stays at 0 no matter how many students actually
-- check in — and when a student's OWN device also fails to resolve a
-- session_id (same broken insert, retried from liveWriteAttendance()), their
-- check-in never reaches the `attendance` table at all, even though the
-- app's local/optimistic UI still shows "You're checked in" (that success
-- message is deliberately local-first — see liveWriteAttendance()'s comment
-- in app.js — so it never surfaces this failure to the student).
--
-- Fix: allow a Lecturer to insert a `sessions` row for a class they actually
-- teach — mirrors the ownership check already used elsewhere in this schema
-- (support_tickets_insert_own, system_settings_update_admin: check the
-- authenticated user's own id/role via auth.uid(), never trust a
-- client-supplied id column directly). `sessions` is used for nothing else
-- in this app right now (grep confirms only liveEnsureSchedulingSession()
-- and the read-only liveResolveSessionId() touch it), so this doesn't loosen
-- any other access path.
--
-- Safe to run once — drop-then-create is idempotent.

drop policy if exists "sessions_insert_own_class" on public.sessions;
create policy "sessions_insert_own_class"
  on public.sessions
  for insert
  with check (
    exists (
      select 1 from public.classes c
      where c.id = sessions.class_id
        and c.teacher_id = auth.uid()
    )
  );
