-- Adds term_start_date to system_settings, the anchor date the real
-- Lecturer Compliance report (Registrar's Analytics & Compliance screen)
-- now uses to compute "sessions expected" -- previously that whole report
-- was 3 permanently-hardcoded fictional lecturers/numbers with no live
-- computation at all. Set once here and updated by an Administrator at the
-- start of each new term, in the System Settings screen.
--
-- Safe to run once. No data migration needed -- existing row just gets a
-- new nullable column.

alter table public.system_settings
  add column if not exists term_start_date date;
