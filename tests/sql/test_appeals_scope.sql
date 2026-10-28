\set ON_ERROR_STOP on
alter table public.users add column if not exists university_id text;
alter table public.users add column if not exists faculty_key text;
create or replace function public.can_write_faculty(k text) returns boolean language sql stable security definer as $$
  select exists (select 1 from public.users u where u.id = auth.uid() and (u.role = 'administrator' or (u.role = 'registrar' and u.faculty_key = k))) $$;
drop table if exists public.attendance_appeals cascade;
create table public.attendance_appeals(id uuid primary key default gen_random_uuid(), student_id text, student_name text, course text, reason text, status text default 'pending');
alter table public.attendance_appeals enable row level security;
create policy "Students insert own appeals" on public.attendance_appeals for insert to public with check (student_id = (select university_id from public.users where id = auth.uid()));
create policy "Students read own appeals" on public.attendance_appeals for select to public using (student_id = (select university_id from public.users where id = auth.uid()));
create policy "Admin/Registrar read all appeals" on public.attendance_appeals for select to public using (exists (select 1 from public.users u where u.id = auth.uid() and u.role in ('administrator','registrar')));
create policy "Admin/Registrar update appeals" on public.attendance_appeals for update to public using (exists (select 1 from public.users u where u.id = auth.uid() and u.role in ('administrator','registrar')));
grant select, insert, update on public.attendance_appeals to authenticated; grant select on public.users to authenticated;
delete from public.users where id in ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000b3','00000000-0000-0000-0000-0000000000b4','00000000-0000-0000-0000-0000000000b5');
insert into public.users(id,name,role,university_id,faculty_key) values
 ('00000000-0000-0000-0000-0000000000b1','Stud CS','student','S-CS','cs'),
 ('00000000-0000-0000-0000-0000000000b2','Stud Bus','student','S-BUS','bus'),
 ('00000000-0000-0000-0000-0000000000b3','Reg CS','registrar','R-CS','cs'),
 ('00000000-0000-0000-0000-0000000000b4','Reg Bus','registrar','R-BUS','bus'),
 ('00000000-0000-0000-0000-0000000000b5','Admin','administrator','A-1',null);
-- an old appeal that exists before the migration (backfill path)
insert into public.attendance_appeals(student_id,student_name,course,reason) values ('S-BUS','Stud Bus','BUS1','old appeal');
\i migrate-appeals-faculty-scope.sql
\i migrate-appeals-faculty-scope.sql
drop table if exists public.ares, public.aexp; create table public.ares(step text, got text); create table public.aexp(step text, want text); grant all on public.ares to public;
create or replace function public.cnt(p_step text) returns void language plpgsql as $$ begin insert into ares select p_step, count(*)::text from public.attendance_appeals; end $$;
grant execute on function public.cnt(text) to public;
set role authenticated;
set app.uid='00000000-0000-0000-0000-0000000000b1';
insert into public.attendance_appeals(student_id,student_name,course,reason,faculty_key) values ('S-CS','Stud CS','CS1','late','bus');  -- client lies about faculty
select cnt('student sees only own');
set app.uid='00000000-0000-0000-0000-0000000000b3';
select cnt('registrar CS sees CS only');
do $$ declare n int; begin update public.attendance_appeals set status='approved' where student_id='S-BUS'; get diagnostics n=row_count; insert into ares values ('registrar CS updates other faculty', n::text); end $$;
do $$ declare n int; begin update public.attendance_appeals set status='approved' where student_id='S-CS'; get diagnostics n=row_count; insert into ares values ('registrar CS updates own faculty', n::text); end $$;
set app.uid='00000000-0000-0000-0000-0000000000b4';
select cnt('registrar Bus sees Bus only');
set app.uid='00000000-0000-0000-0000-0000000000b5';
select cnt('administrator sees all');
reset role;
insert into ares select 'stored key ignores client value', faculty_key from public.attendance_appeals where student_id='S-CS';
insert into ares select 'old appeal backfilled', faculty_key from public.attendance_appeals where student_id='S-BUS';
insert into aexp values ('student sees only own','1'),('registrar CS sees CS only','1'),('registrar CS updates other faculty','0'),('registrar CS updates own faculty','1'),('registrar Bus sees Bus only','1'),('administrator sees all','2'),('stored key ignores client value','cs'),('old appeal backfilled','bus');
do $$ declare bad text; begin
  select string_agg(r.step||': got '||coalesce(r.got,'null')||', wanted '||e.want, '; ') into bad from ares r join aexp e using(step) where r.got is distinct from e.want;
  if bad is not null then raise exception 'appeals scope checks failed: %', bad; end if;
  if (select count(*) from ares) <> (select count(*) from aexp) then raise exception 'scenario count mismatch'; end if;
  raise notice 'appeals scope: all % checks passed', (select count(*) from ares);
end $$;
