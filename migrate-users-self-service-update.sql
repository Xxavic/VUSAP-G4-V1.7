-- Fixes a confirmed live bug: after a student/lecturer sets their real
-- password on the Forced Password Change screen ("Set Password &
-- Continue"), or accepts the attendance/device-tracking consent notice,
-- app.js's authUpdatePassword() / authRecordConsent() try to clear their
-- OWN must_change_password / consent_at flag on their OWN public.users
-- row. But the only UPDATE policy on public.users is "Admin/Registrar
-- update profiles" (migrate-faculty-scoped-reads.sql), scoped by
-- can_write_faculty() — a student updating their own row matches no
-- policy at all. RLS on UPDATE filters rows via its USING clause, so
-- Postgres/PostgREST just returns success with 0 rows affected — no
-- error is raised, the write silently does nothing.
--
-- Confirmed symptom (Sept 2026): a brand-new student sets their password
-- on first login and the screen loops right back to itself instead of
-- reaching the dashboard. Root cause: authUpdatePassword()'s live branch
-- treats the profile-flag clear as best-effort and still returns
-- { ok: true } even when the profile UPDATE silently no-ops, so it never
-- flips State.user.mustChangePassword to false in memory either. The
-- very next navigate() call re-runs mustChangePasswordGate(), still sees
-- mustChangePassword === true, and re-renders the same forced-password
-- screen — forever, because the live row itself was never actually
-- updated no matter how many times the person "sets" a new password.
--
-- authRecordConsent() has the identical gap for consent_at. It fails
-- less visibly this session (submitConsent() always flips
-- State.user.consentAt in memory regardless of the live result), but the
-- live consent_at column is never actually set either, so the consent
-- notice would keep reappearing on every future login too.
--
-- Fix: let a signed-in user update ONLY these two self-service flags on
-- their OWN row. Deliberately NOT a blanket "update your own profile"
-- policy — RLS is row-scoped, not column-scoped, and a bare
-- `id = auth.uid()` policy would let anyone rewrite their own role,
-- faculty_key, status, etc. straight from browser devtools. A BEFORE
-- UPDATE trigger enforces the column restriction whenever the row is
-- being changed by someone who does NOT already have
-- can_write_faculty() rights over it (i.e. every path other than the
-- existing "Admin/Registrar update profiles" policy) — staff keep
-- editing every column exactly as before.
--
-- Safe to run once — the function, trigger, and policy are all
-- dropped-then-recreated.

create or replace function public.enforce_self_service_profile_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Admin/Registrar staff already have their own unrestricted policy
  -- ("Admin/Registrar update profiles") — this trigger only needs to
  -- police updates that got through solely via the new self-service
  -- policy below, i.e. anyone without can_write_faculty rights over the
  -- row being changed.
  if can_write_faculty(old.faculty_key) then
    return new;
  end if;

  if new.id is distinct from old.id
     or new.university_id is distinct from old.university_id
     or new.name is distinct from old.name
     or new.role is distinct from old.role
     or new.email is distinct from old.email
     or new.faculty_key is distinct from old.faculty_key
     or new.program is distinct from old.program
     or new.year is distinct from old.year
     or new.mode is distinct from old.mode
     or new.status is distinct from old.status
     or new.gender is distinct from old.gender
     or new.semester is distinct from old.semester
     or new.is_class_coordinator is distinct from old.is_class_coordinator
     or new.coordinator_for_programme is distinct from old.coordinator_for_programme
     or new.coordinator_for_year is distinct from old.coordinator_for_year
  then
    raise exception 'Only must_change_password and consent_at may be self-updated';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_self_service_profile_update on public.users;
create trigger trg_enforce_self_service_profile_update
  before update on public.users
  for each row
  execute function public.enforce_self_service_profile_update();

drop policy if exists "Users can clear their own first-login flags" on public.users;
create policy "Users can clear their own first-login flags"
  on public.users
  for update
  using ( id = auth.uid() )
  with check ( id = auth.uid() );
