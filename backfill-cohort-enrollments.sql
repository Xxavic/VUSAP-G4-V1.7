-- Enroll students in every course of their own programme + year (+ mode) that
-- they are missing. Students were only ever enrolled when their account was
-- created, so a course added or re-tagged later never reached them.
-- Only adds rows; nobody is removed. Safe to run more than once.

-- 1. PREVIEW: who would be enrolled in what (run this first, nothing changes)
select u.name, u.university_id, u.year, u.mode as student_mode,
       c.code, c.name as course, coalesce(c.mode, 'any') as course_mode, p.name as programme
from public.users u
join public.programmes p on p.name = u.program
join public.faculties f on f.id = p.faculty_id and (u.faculty_key is null or f.key = u.faculty_key)
join public.classes c on c.programme_id = p.id and c.year = u.year
                     and (c.mode is null or c.mode = u.mode)
where u.role = 'student'
  and not exists (select 1 from public.enrollments e where e.student_id = u.id and e.class_id = c.id)
order by c.code, u.name;

-- 2. ENROLL them (same rows as the preview)
insert into public.enrollments (student_id, class_id)
select distinct u.id, c.id
from public.users u
join public.programmes p on p.name = u.program
join public.faculties f on f.id = p.faculty_id and (u.faculty_key is null or f.key = u.faculty_key)
join public.classes c on c.programme_id = p.id and c.year = u.year
                     and (c.mode is null or c.mode = u.mode)
where u.role = 'student'
  and not exists (select 1 from public.enrollments e where e.student_id = u.id and e.class_id = c.id);
