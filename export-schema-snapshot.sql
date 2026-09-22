-- ============================================================================
-- SCHEMA SNAPSHOT — read-only introspection, safe to run on the LIVE
-- Victoria University project.
--
-- Purpose: of the 18 tables the app actually queries, 13 have no CREATE
-- TABLE anywhere in version control (users, faculties, programmes, classes,
-- enrollments, attendance, attendance_appeals, sessions, timetable_slots,
-- live_qr_sessions, fraud_logs, audit_log, notifications). They were built
-- directly in the Supabase dashboard over time and were never exported.
-- (The other 5 -- account_deletion_requests, announcements,
-- course_attendance_caps, support_tickets, system_settings -- are already
-- covered, each by its own migrate-*.sql file.) Before a second client's
-- Supabase project can be stood up,
-- someone needs the REAL schema — columns, types, defaults, constraints,
-- indexes, RLS policies, functions and triggers — not a guess reconstructed
-- from what app.js happens to query.
--
-- This script only SELECTs from Postgres system catalogs. It changes
-- nothing and is safe to run against production.
--
-- HOW TO RUN
--   Easiest: Supabase Dashboard → SQL Editor → paste this whole file → Run.
--   Each numbered section below returns its own result set; the SQL Editor
--   shows them as separate tabs. Copy each tab's output (there's a
--   download/copy button) and save it — that's your schema snapshot.
--
--   If you have PostgreSQL client tools installed and would rather get a
--   single ready-to-run schema.sql directly, this one command does the
--   same job better (full DDL, in the right order, no copy/paste):
--
--     pg_dump "postgresql://postgres:[YOUR-DB-PASSWORD]@db.[YOUR-PROJECT-REF].supabase.co:5432/postgres" \
--       --schema-only --schema=public --no-owner --no-privileges \
--       > schema-dump.sql
--
--   Your DB password and connection string are in Supabase Dashboard →
--   Project Settings → Database. Run that yourself — don't paste the
--   password anywhere, including to Claude.
--
--   Either output then needs the same next step: load it into a *new*,
--   empty Supabase project (never the live one) and confirm the app boots
--   against it before any client data goes near it.
-- ============================================================================


-- 1) Every column of every public table: name, type, nullability, default.
select
  c.table_name,
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.udt_name,
  c.character_maximum_length,
  c.numeric_precision,
  c.is_nullable,
  c.column_default
from information_schema.columns c
where c.table_schema = 'public'
order by c.table_name, c.ordinal_position;


-- 2) Primary keys.
select
  tc.table_name,
  kcu.column_name,
  tc.constraint_name
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on tc.constraint_name = kcu.constraint_name
 and tc.table_schema = kcu.table_schema
where tc.constraint_type = 'PRIMARY KEY'
  and tc.table_schema = 'public'
order by tc.table_name;


-- 3) Foreign keys (which tables reference which, and on delete/update rules
--    — important: e.g. what happens to attendance rows when a user is
--    deleted, which is exactly what supabase/functions/delete-user relies
--    on getting right).
select
  tc.table_name       as table_name,
  kcu.column_name      as column_name,
  ccu.table_name       as references_table,
  ccu.column_name      as references_column,
  rc.update_rule,
  rc.delete_rule
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
join information_schema.constraint_column_usage ccu
  on tc.constraint_name = ccu.constraint_name
join information_schema.referential_constraints rc
  on tc.constraint_name = rc.constraint_name
where tc.constraint_type = 'FOREIGN KEY'
  and tc.table_schema = 'public'
order by tc.table_name;


-- 4) Unique and check constraints (full definition, e.g. any "role in
--    (...)" style check constraints on users.role).
select
  conname,
  conrelid::regclass as table_name,
  pg_get_constraintdef(oid) as definition
from pg_constraint
where connamespace = 'public'::regnamespace
  and contype in ('u', 'c')
order by table_name, conname;


-- 5) Indexes (including any not implied by a constraint above).
select
  tablename,
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
order by tablename, indexname;


-- 6) Which tables have row level security turned on at all.
select
  relname as table_name,
  relrowsecurity as rls_enabled,
  relforcerowsecurity as rls_forced
from pg_class
where relnamespace = 'public'::regnamespace
  and relkind = 'r'
order by relname;


-- 7) Every RLS policy, verbatim — this is the part that genuinely cannot
--    be reconstructed by reading app.js, since client code shows what's
--    attempted, not what the database actually permits. Get this wrong on
--    a new client's project and students could end up able to read or
--    write rows they shouldn't.
select
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;


-- 8) Custom functions (e.g. the coordinator-limit trigger function
--    referenced in migrate-coordinator-limit.sql, and anything else
--    defined directly in the dashboard).
select
  p.proname as function_name,
  pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on p.pronamespace = n.oid
where n.nspname = 'public'
order by p.proname;


-- 9) Triggers.
select
  t.tgname as trigger_name,
  c.relname as table_name,
  pg_get_triggerdef(t.oid) as definition
from pg_trigger t
join pg_class c on t.tgrelid = c.oid
where not t.tgisinternal
  and c.relnamespace = 'public'::regnamespace
order by c.relname, t.tgname;


-- 10) Sequences (relevant if anything uses serial/bigserial rather than
--     a default like gen_random_uuid()).
select
  sequence_name,
  data_type,
  start_value,
  minimum_value,
  maximum_value,
  increment
from information_schema.sequences
where sequence_schema = 'public';


-- 11) Extensions in use (e.g. pgcrypto, needed for gen_random_uuid()) —
--     a fresh project needs these enabled before the schema will apply.
select extname, extversion
from pg_extension
order by extname;
