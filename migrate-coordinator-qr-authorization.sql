-- Adds a `coordinator_authorized` flag to `live_qr_sessions` so a Lecturer
-- can authorize their class's Class Coordinator to display the live
-- attendance QR code from the Coordinator's own device (e.g. while the
-- Lecturer is occupied setting up or teaching). Off by default — a live
-- session broadcasts with this false until the Lecturer explicitly turns it
-- on from the Live Session screen, and can revoke it at any time.
--
-- This is plain row data, not a new access grant: the existing
-- "readable by anyone signed in" / "writable only by the owning Lecturer"
-- policies on live_qr_sessions already cover this column since Postgres
-- RLS is row-level, not column-level. No policy changes needed.
--
-- Safe to run once — `add column if not exists` is idempotent.

alter table public.live_qr_sessions
  add column if not exists coordinator_authorized boolean not null default false;
