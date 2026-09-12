-- Adds a `system_settings` table so the Administrator's System Settings
-- screen (portal name, institute logo, academic year, etc.) actually
-- persists — it was previously a plain in-memory object in app.js that
-- reset to hardcoded defaults on every page load and was never shared
-- across visitors/devices.
--
-- Singleton table: exactly one row, id = 1, seeded below. Readable by
-- anyone (the login screen and boot splash need it before any auth
-- session exists), writable only by an Administrator.
--
-- Safe to run once. The seed insert is idempotent (on conflict do nothing).

create table if not exists public.system_settings (
  id int primary key default 1,
  system_name text not null default 'VUSAP',
  institution_name text not null default 'Victoria University',
  portal_name text not null default 'Victoria University Smart Attendance Portal',
  support_email text not null default 'support@vu.ac.ug',
  academic_year text not null default '2025/2026',
  auto_logout_minutes int not null default 30,
  require_email_verification boolean not null default true,
  allow_self_enrollment boolean not null default false,
  maintenance_mode boolean not null default false,
  logo_data_uri text,
  updated_at timestamptz not null default now(),
  constraint system_settings_singleton check (id = 1)
);

insert into public.system_settings (id)
values (1)
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
