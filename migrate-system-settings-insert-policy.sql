-- Fixes a live bug: saving the Administrator's System Settings screen always
-- shows "Saved on this device only — couldn't reach the server", even though
-- the connection is fine.
--
-- Root cause: saveSystemSettingsToSupabase() (app.js) writes with
-- .upsert({ id: 1, ... }), which Postgres executes as an INSERT ... ON
-- CONFLICT (id) DO UPDATE. RLS checks INSERT privilege for that statement
-- regardless of which branch (insert vs. update) it ends up taking.
-- migrate-system-settings.sql only ever defined a SELECT policy (anyone)
-- and an UPDATE policy (Administrator) for `system_settings` — no INSERT
-- policy — so the upsert's implicit insert check has nothing to satisfy it
-- and is rejected by default, surfacing as:
--   {code: 42501, message: 'new row violates row-level security policy
--    for table "system_settings"'}
-- which the UI swallows into its generic offline-looking message.
--
-- Fix: allow an Administrator to insert into `system_settings`, mirroring
-- the existing system_settings_update_admin check. The table is a
-- constrained singleton (id must be 1, enforced by system_settings_singleton),
-- so this can't be used to add extra rows — it only unblocks the upsert's
-- insert branch for the one legitimate row.
--
-- Safe to run once — drop-then-create is idempotent.

drop policy if exists "system_settings_insert_admin" on public.system_settings;
create policy "system_settings_insert_admin"
  on public.system_settings
  for insert
  with check (exists (select 1 from public.users where id = auth.uid() and role = 'administrator'));
