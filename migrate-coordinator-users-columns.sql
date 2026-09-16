-- Adds the Class Coordinator flag columns to `public.users` itself.
--
-- These were only ever written to the in-memory mock USERS object by
-- handleEnroll() (Student Register -> Enroll Student), never to Supabase —
-- so for any account authenticated via live Supabase auth (Gate 3), the
-- Class Coordinator Tools card / Display QR Code entry point never showed
-- up at all, no matter what the enroll checkbox did. app.js's
-- normalizeProfile() already spreads the raw profile row onto State.user,
-- so populating these columns is the only piece missing — no app.js
-- read-path changes needed once they exist.
--
-- Same reasoning as migrate-coordinator-qr-authorization.sql: this is
-- plain row data, not a new access grant. Row-level security on
-- `public.users` is row-level, not column-level, and a Registrar/
-- Administrator session can already update arbitrary student rows
-- (verified against the live project before writing this migration) — so
-- no policy changes are needed here either.
--
-- Safe to run once — `add column if not exists` is idempotent.

alter table public.users
  add column if not exists is_class_coordinator boolean not null default false,
  add column if not exists coordinator_for_programme text,
  add column if not exists coordinator_for_year text;
