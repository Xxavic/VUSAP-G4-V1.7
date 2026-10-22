-- Adds a `system_settings` table so the Administrator's System Settings
-- screen (portal name, institute logo, academic year, etc.) actually
-- persists — it was previously a plain in-memory object in app.js that
-- reset to hardcoded defaults on every page load and was never shared
-- across visitors/devices.
--
-- Singleton table: exactly one row, id = 1, seeded below. Readable by
-- anyone (the login screen and boot splash need it before any auth
-- session exists), updatable only by an Administrator.
--
-- Note: this migration only defines SELECT and UPDATE policies. The
-- Administrator save flow uses .upsert(), which Postgres runs as
-- INSERT ... ON CONFLICT DO UPDATE, so it also needs INSERT privilege —
-- see migrate-system-settings-insert-policy.sql for that policy.
--
-- Safe to run once. The seed insert is idempotent (on conflict do nothing).

create table if not exists public.system_settings (
  id int primary key default 1,
  system_name text not null default 'QRAST',
  institution_name text not null default 'Your Institution',
  portal_name text not null default 'QR-code Realtime Attendance Scanning Technology',
  support_email text not null default '',
  academic_year text not null default '2025/2026',
  auto_logout_minutes int not null default 30,
  require_email_verification boolean not null default true,
  allow_self_enrollment boolean not null default false,
  maintenance_mode boolean not null default false,
  logo_data_uri text,
  updated_at timestamptz not null default now(),
  constraint system_settings_singleton check (id = 1)
);

-- Values are spelled out (not left to the column defaults) because a new
-- client's base schema may come from a pg_dump of Victoria's project, whose
-- system_settings defaults still say "Victoria University". The Administrator
-- sets the real name, portal name and crest in System Settings after first
-- sign-in. On an existing project the row already exists and is untouched.
insert into public.system_settings (id, institution_name, portal_name, support_email)
values (1, 'Your Institution', 'QR-code Realtime Attendance Scanning Technology', '')
on conflict (id) do nothing;

alter table public.system_settings enable row level security;

drop policy if exists "system_settings_select_all" on public.system_settings;
create policy "system_settings_select_all"
  on public.system_settings
  for select
  using (true);

drop policy if exists "system_settings_update_admin" on public.system_settings;
create policy "system_settings_update_admin"
  on public.system_settings
  for update
  using (exists (select 1 from public.users where id = auth.uid() and role = 'administrator'))
  with check (exists (select 1 from public.users where id = auth.uid() and role = 'administrator'));
