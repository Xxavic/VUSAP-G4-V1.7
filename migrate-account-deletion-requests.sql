-- Adds account_deletion_requests — the approval trail for deleting a freshly
-- enrolled student who has no records yet (so they can be re-enrolled, e.g.
-- after a wrong email or a lost temporary password).
--
-- Flow: a Registrar requests deletion (reason required) -> the Administrator
-- approves or rejects -> the delete-user Edge Function does the actual delete.
-- All writes happen inside that Edge Function with the service role, which is
-- why there are no insert/update policies below: the browser can only READ.
-- Rows are kept after the student is deleted (target_* columns are plain
-- copies, not foreign keys) so there's a permanent record of who asked and who
-- approved.
--
-- New table only — touches nothing existing. Safe to run once.

create table if not exists public.account_deletion_requests (
  id bigint generated always as identity primary key,
  target_university_id text not null,
  target_name text not null,
  faculty_key text,
  reason text not null,
  requested_by_supabase_id uuid not null,
  requested_by_id text not null,
  requested_by_name text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by_name text,
  decision_note text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

-- At most one open request per student.
create unique index if not exists account_deletion_requests_one_pending
  on public.account_deletion_requests (target_university_id)
  where status = 'pending';

alter table public.account_deletion_requests enable row level security;

drop policy if exists "account_deletion_requests_select_scoped" on public.account_deletion_requests;
create policy "account_deletion_requests_select_scoped"
  on public.account_deletion_requests
  for select
  using (
    requested_by_supabase_id = auth.uid()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and (
          u.role = 'administrator'
          or (u.role = 'registrar' and u.faculty_key = account_deletion_requests.faculty_key)
        )
    )
  );
