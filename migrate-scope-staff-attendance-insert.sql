-- ============================================================================
-- Staff may only insert attendance for sessions they are responsible for.
--
-- The policy "Staff insert attendance" let ANY lecturer insert attendance rows for ANY
-- session of ANY course (it only checked the role). It now matches the existing
-- "Staff update attendance" rule: the lecturer who teaches the session's class, or
-- an administrator / the registrar of that class's faculty (can_write_faculty).
--
-- Note: an attendance row with no session_id is no longer insertable by staff.
-- Idempotent.
-- ============================================================================
drop policy if exists "Staff insert attendance" on public.attendance;
drop policy if exists attendance_insert_staff_scoped on public.attendance;
create policy attendance_insert_staff_scoped on public.attendance
  for insert to authenticated
  with check (
    exists (
      select 1 from public.sessions s
      join public.classes c on c.id = s.class_id
      where s.id = attendance.session_id and c.teacher_id = auth.uid()
    )
    or public.can_write_faculty((
      select f.key
      from public.faculties f
      join public.programmes p on p.faculty_id = f.id
      join public.classes c on c.programme_id = p.id
      join public.sessions s on s.class_id = c.id
      where s.id = attendance.session_id
    ))
  );
