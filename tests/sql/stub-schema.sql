drop schema if exists public cascade; create schema public; grant usage on schema public to public; drop schema if exists auth cascade; create schema auth;
do $$ begin if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; end $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
create table public.users(id uuid primary key, name text, role text, is_class_coordinator boolean);
create table public.classes(id uuid primary key default gen_random_uuid(), code text, teacher_id uuid);
create table public.enrollments(student_id uuid, class_id uuid);
create table public.sessions(id uuid primary key default gen_random_uuid(), class_id uuid, teacher_id uuid, topic text, date date, created_at timestamptz default now());
create table public.attendance(id uuid primary key default gen_random_uuid(), session_id uuid, live_broadcast_id uuid, student_id uuid, student_name text, status text, device_id text, marked_at timestamptz default now(), unique(session_id, student_id));
create table public.live_qr_sessions(id uuid primary key default gen_random_uuid(), course_code text, course_name text, class_id uuid, lecturer_id uuid, active boolean default true, started_at timestamptz default now(), token text, pin text, coordinator_authorized boolean default false);
