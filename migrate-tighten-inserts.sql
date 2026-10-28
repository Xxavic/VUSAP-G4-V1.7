-- ============================================================================
-- Tighten who may write notifications, audit entries and fraud flags.
--
-- Until now any signed-in user could insert ANY row into these three tables, so a
-- student could send a notice that appears to come from the administrator, forge or
-- flood the audit trail, or file a fraud flag with no traceable author.
--
--  notifications  A sender may only name themselves in from_id (or 'system'), may only
--                 claim their own role, and a student may only write to staff roles
--                 (lecturer / registrar / administrator), never to other students.
--                 Lecturers, registrars and administrators can still message anyone.
--                 Title and body are length-limited.
--  audit_log      The row must carry the caller's own id in actor_supabase_id (the column
--                 already defaults to auth.uid(), so the app is unaffected) - an entry can
--                 no longer be attributed to someone else.
--  fraud_logs     A new reported_by column is stamped with the caller's id by default and
--                 must match it, so every flag has a traceable author. Lengths are limited.
--
-- Idempotent. Existing rows are untouched.
-- ============================================================================

-- ---- notifications ----
drop policy if exists "Authenticated users send notifications" on public.notifications;
drop policy if exists notifications_insert_scoped on public.notifications;
create policy notifications_insert_scoped on public.notifications
  for insert to authenticated
  with check (
    length(title) between 1 and 200
    and length(body) between 1 and 4000
    and exists (
      select 1 from public.users u
      where u.id = auth.uid()
        -- may only speak as themselves, or as the system. (A profile with no
        -- university_id yet is not blocked, so nobody is locked out of sending.)
        and (from_id is null or from_id = 'system' or u.university_id is null or from_id = u.university_id)
        and (from_role is null or from_role = u.role)
        -- students write to staff only
        and (u.role in ('lecturer', 'registrar', 'administrator')
             or recipient_role in ('lecturer', 'registrar', 'administrator'))
    )
  );

-- ---- audit_log ----
drop policy if exists "Authenticated users write audit log" on public.audit_log;
drop policy if exists audit_log_insert_self on public.audit_log;
create policy audit_log_insert_self on public.audit_log
  for insert to authenticated
  with check (
    actor_supabase_id = auth.uid()
    and length(action) <= 200
    and coalesce(length(detail), 0) <= 4000
  );

-- ---- fraud_logs ----
alter table public.fraud_logs add column if not exists reported_by uuid default auth.uid();

drop policy if exists "Authenticated users insert fraud logs" on public.fraud_logs;
drop policy if exists fraud_logs_insert_self on public.fraud_logs;
create policy fraud_logs_insert_self on public.fraud_logs
  for insert to authenticated
  with check (
    reported_by = auth.uid()
    and length(reason) <= 500
    and length(student) <= 200
  );
