-- ============================================================================
-- Stop students writing their own attendance rows directly.
--
-- Before server-side check-in, the phone inserted the attendance row itself, so a
-- policy let a student insert a row for themselves. Now check_in_to_broadcast()
-- (security definer) verifies the QR or PIN and writes the row. Leaving the old
-- policy means a student can skip that check by calling the table API directly
-- and mark themselves present for any session from anywhere.
--
-- Safe to run only AFTER migrate-server-side-checkin.sql (already live: the
-- function exists). Lecturers, registrars and administrators keep their own
-- policies, and the RPC is unaffected because it bypasses row-level security.
-- Idempotent.
-- ============================================================================
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'check_in_to_broadcast') then
    raise exception 'check_in_to_broadcast() is missing: run migrate-server-side-checkin.sql first, otherwise students could not check in at all';
  end if;
end $$;

drop policy if exists "Students insert own attendance" on public.attendance;
