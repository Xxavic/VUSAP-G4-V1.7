-- Limits Class Coordinators to at most 2 per programme + year + study mode.
--
-- Why in the database: the app checks this too, but a check in the browser can
-- be skipped from devtools, and two admins/registrars saving at the same
-- moment could each see "only 1 coordinator" and both add one. Enforcing it in
-- a trigger makes the limit real regardless of which client (or Edge Function)
-- writes the row, and the advisory lock below serializes simultaneous saves
-- for the same class so the count can't be raced.
--
-- A "class" = the same coordinator_for_programme, coordinator_for_year and the
-- student's study mode (users.mode: 'day' | 'evening'). Two coordinators in
-- Computer Science / Year 2 / Day is fine; a third is rejected. Computer
-- Science / Year 2 / Evening is a separate class with its own 2 slots.
--
-- The trigger only fires when a row becomes a coordinator or moves to a
-- different class, so existing rows (including any class that is already over
-- the limit today) are not touched or blocked until someone edits them.
-- See the audit query at the bottom to find classes that are over the limit.
--
-- Safe to run more than once.

create or replace function public.enforce_coordinator_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if new.is_class_coordinator is not true then
    return new;
  end if;

  -- Already a coordinator of this same class: nothing changed that matters.
  if tg_op = 'UPDATE'
     and old.is_class_coordinator is true
     and old.coordinator_for_programme is not distinct from new.coordinator_for_programme
     and old.coordinator_for_year is not distinct from new.coordinator_for_year
     and old.mode is not distinct from new.mode
  then
    return new;
  end if;

  if new.role is distinct from 'student' then
    raise exception 'Only students can be Class Coordinators';
  end if;

  if new.coordinator_for_programme is null
     or new.coordinator_for_year is null
     or new.mode is null
  then
    raise exception 'A Class Coordinator needs a programme, year and study mode';
  end if;

  -- One lock per class so two simultaneous saves can't both pass the count.
  perform pg_advisory_xact_lock(
    hashtext('coordinator:' || new.coordinator_for_programme || '|' || new.coordinator_for_year || '|' || new.mode)
  );

  select count(*) into v_count
  from public.users u
  where u.is_class_coordinator is true
    and u.id <> new.id
    and u.coordinator_for_programme = new.coordinator_for_programme
    and u.coordinator_for_year = new.coordinator_for_year
    and u.mode = new.mode;

  if v_count >= 2 then
    raise exception 'This class already has 2 Class Coordinators (maximum 2 per programme, year and study mode)';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_coordinator_limit on public.users;
create trigger trg_enforce_coordinator_limit
  before insert or update of is_class_coordinator, coordinator_for_programme, coordinator_for_year, mode
  on public.users
  for each row
  execute function public.enforce_coordinator_limit();

-- ---------------------------------------------------------------------------
-- Audit (read-only, run by hand): classes that are ALREADY over the limit.
-- Any row returned has more than 2 coordinators; edit one of those students
-- in the app and untick Class Coordinator to bring it back within the limit.
--
--   select coordinator_for_programme, coordinator_for_year, mode,
--          count(*) as coordinators,
--          string_agg(name, ', ' order by name) as who
--   from public.users
--   where is_class_coordinator is true
--   group by 1, 2, 3
--   having count(*) > 2;
-- ---------------------------------------------------------------------------
