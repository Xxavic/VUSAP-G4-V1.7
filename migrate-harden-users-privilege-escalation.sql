-- Closes a privilege-escalation hole on public.users.
--
-- The hole: "Admin/Registrar update profiles" (migrate-faculty-scoped-reads.sql)
-- lets a Registrar UPDATE any user row in their faculty — including their OWN
-- row — and any column. Row Level Security is row-scoped, not column-scoped, so
-- from browser devtools a Registrar could run
--     supabase.from('users').update({ role: 'administrator' }).eq('id', <own id>)
-- and become an Administrator. The trigger added by
-- migrate-users-self-service-update.sql deliberately returns early for anyone
-- with can_write_faculty() rights, so it does not stop this either.
--
-- The fix, all enforced in the database (the browser is never trusted):
--   * Administrators: unrestricted (unchanged).
--   * Anyone editing their OWN row (Registrar, Lecturer, Student alike): only
--     must_change_password and consent_at may change. Implemented as an
--     ALLOWLIST via to_jsonb(), so any column added to users in future is
--     protected by default instead of silently self-editable.
--   * Registrars editing SOMEONE ELSE: only Student/Lecturer rows, and they
--     cannot change a row's role to anything but Student/Lecturer, so they can
--     never promote anyone to Registrar/Administrator. They cannot move a row
--     into a faculty they don't manage.
--   * No end-user JWT (auth.uid() is null): Edge Functions using the
--     service-role key, and the SQL editor, are unaffected — create-user,
--     delete-user etc. keep working.
--
-- This replaces trg_enforce_self_service_profile_update, which used a
-- denylist of columns.
--
-- Also adds an explicit WITH CHECK to the staff update policy.
--
-- Safe to run more than once. RUN IT IN A TEST PROJECT FIRST if you have one,
-- then sanity-check: sign in as a Registrar and confirm you can still edit a
-- Student's name, and can no longer change any user's role to administrator.

create or replace function public.enforce_users_update_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role text;
begin
  -- Service role / SQL editor / Edge Functions: no end-user session.
  if auth.uid() is null then
    return new;
  end if;

  select role into caller_role from public.users where id = auth.uid();

  if caller_role = 'administrator' then
    return new;
  end if;

  -- Editing your own row: first-login flags only.
  if old.id = auth.uid() then
    if (to_jsonb(new) - 'must_change_password' - 'consent_at')
       is distinct from
       (to_jsonb(old) - 'must_change_password' - 'consent_at')
    then
      raise exception 'Only must_change_password and consent_at may be self-updated';
    end if;
    return new;
  end if;

  if caller_role = 'registrar' then
    if old.role not in ('student', 'lecturer') or new.role not in ('student', 'lecturer') then
      raise exception 'Registrars can only manage Student and Lecturer profiles';
    end if;
    if new.faculty_key is distinct from old.faculty_key
       and not can_write_faculty(new.faculty_key)
    then
      raise exception 'You can only assign accounts to your own faculty';
    end if;
    return new;
  end if;

  raise exception 'Not permitted to update this profile';
end;
$$;

drop trigger if exists trg_enforce_self_service_profile_update on public.users;
drop function if exists public.enforce_self_service_profile_update();

drop trigger if exists trg_enforce_users_update_rules on public.users;
create trigger trg_enforce_users_update_rules
  before update on public.users
  for each row
  execute function public.enforce_users_update_rules();

drop policy if exists "Admin/Registrar update profiles" on public.users;
create policy "Admin/Registrar update profiles"
  on public.users
  for update
  using ( can_write_faculty(users.faculty_key) )
  with check ( can_write_faculty(users.faculty_key) );

-- ---------------------------------------------------------------------------
-- Audit queries — run these by hand in the SQL editor and read the results.
-- (They are read-only; the repo's SQL files don't create every table, so this
-- is how you confirm what is actually live.)
-- ---------------------------------------------------------------------------
--
-- 1. Any table WITHOUT row level security (anyone with the public anon key can
--    read/write it). Every row returned needs "alter table ... enable row
--    level security" plus policies:
--
--    select schemaname, tablename
--    from pg_tables
--    where schemaname = 'public' and not rowsecurity;
--
-- 2. Every policy on users — look for any INSERT policy that would let a user
--    create a row for themselves with role = 'administrator', and any policy
--    that grants access to the anon role:
--
--    select policyname, cmd, roles, qual, with_check
--    from pg_policies where schemaname = 'public' and tablename = 'users';
--
-- 3. Policies that are open to everyone (using (true)) — intended for
--    system_settings SELECT (login-screen branding), suspicious elsewhere:
--
--    select tablename, policyname, cmd, roles
--    from pg_policies
--    where schemaname = 'public' and (qual = 'true' or with_check = 'true');
--
-- 4. The definition of the helper every policy leans on — confirm it derives
--    the role from public.users by auth.uid(), never from the request:
--
--    select pg_get_functiondef('public.can_write_faculty(text)'::regprocedure);
