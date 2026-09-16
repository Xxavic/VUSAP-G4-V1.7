-- Adds:
--   1. users.consent_at — records when a person accepted the one-time
--      attendance/device-tracking consent notice shown on first login
--      (mirrors Mak-BAMS's own signed biometric consent form, adapted to
--      what VUSAP actually collects: a rotating check-in code + an
--      anonymized device identifier, not biometrics). NULL means "not yet
--      accepted" and re-triggers the consent screen on next login.
--   2. support_tickets — the "Report an Issue" feature, mirroring Mak-BAMS's
--      tiered support model: Student/Lecturer reports land with their
--      faculty Registrar (1st line, tier='registrar'); a Registrar's own
--      report lands with the Administrator (2nd line, tier='administrator');
--      the Administrator can mark a ticket escalated to developer/vendor
--      support (3rd line, tier='developer') via the app's Escalate action.
--
-- New table + one new nullable column on an existing table — nothing here
-- touches existing rows or drops anything. Safe to run once.

alter table public.users
  add column if not exists consent_at timestamptz;

create table if not exists public.support_tickets (
  id bigint generated always as identity primary key,
  -- Both id shapes on purpose, matching the app's own two identities for a
  -- person: reporter_supabase_id is what RLS below checks against auth.uid();
  -- reporter_id is the human-readable university ID (e.g. VU-LEC-101) the
  -- rest of the app already displays everywhere else.
  reporter_supabase_id uuid not null references auth.users(id),
  reporter_id text not null,
  reporter_name text not null,
  reporter_role text not null,
  faculty_key text,
  category text not null,
  subject text not null,
  description text not null,
  status text not null default 'open' check (status in ('open','resolved')),
  tier text not null default 'registrar' check (tier in ('registrar','administrator','developer')),
  resolved_at timestamptz,
  resolved_by text,
  resolution_note text,
  created_at timestamptz not null default now()
);

alter table public.support_tickets enable row level security;

-- Anyone signed in can submit their own ticket.
drop policy if exists "support_tickets_insert_own" on public.support_tickets;
create policy "support_tickets_insert_own"
  on public.support_tickets
  for insert
  with check (reporter_supabase_id = auth.uid());

-- A reporter sees their own tickets. A Registrar sees tickets from their own
-- faculty plus their own submitted tickets. An Administrator sees
-- everything. Mirrors the app's scopedSupportTickets() exactly.
drop policy if exists "support_tickets_select_scoped" on public.support_tickets;
create policy "support_tickets_select_scoped"
  on public.support_tickets
  for select
  using (
    reporter_supabase_id = auth.uid()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and (
          u.role = 'administrator'
          or (u.role = 'registrar' and u.faculty_key = support_tickets.faculty_key)
        )
    )
  );

-- Only a Registrar (their own faculty) or an Administrator can resolve or escalate a ticket.
drop policy if exists "support_tickets_update_reviewer" on public.support_tickets;
create policy "support_tickets_update_reviewer"
  on public.support_tickets
  for update
  using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and (
          u.role = 'administrator'
          or (u.role = 'registrar' and u.faculty_key = support_tickets.faculty_key)
        )
    )
  );
