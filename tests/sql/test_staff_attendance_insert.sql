\set ON_ERROR_STOP on
alter table public.users add column if not exists university_id text;
alter table public.classes add column if not exists programme_id uuid;
create table if not exists public.faculties(id uuid primary key default gen_random_uuid(), key text);
create table if not exists public.programmes(id uuid primary key default gen_random_uuid(), faculty_id uuid);
-- stub of the live helper: true only for an administrator
create or replace function public.can_write_faculty(k text) returns boolean language sql stable security definer as $$ select exists (select 1 from public.users where id = auth.uid() and role = 'administrator') $$;
alter table public.attendance enable row level security;
drop policy if exists "Staff insert attendance" on public.attendance;
create policy "Staff insert attendance" on public.attendance for insert to public with check (exists (select 1 from public.users u where u.id = auth.uid() and u.role in ('lecturer','registrar','administrator')));
\i migrate-scope-staff-attendance-insert.sql
\i migrate-scope-staff-attendance-insert.sql
delete from public.users where id in ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000f3');
insert into public.users(id,name,role) values ('00000000-0000-0000-0000-0000000000f1','Own lecturer','lecturer'),('00000000-0000-0000-0000-0000000000f2','Other lecturer','lecturer'),('00000000-0000-0000-0000-0000000000f3','Admin','administrator');
insert into public.classes(id,code,teacher_id) values ('00000000-0000-0000-0000-00000000c001','C1','00000000-0000-0000-0000-0000000000f1') on conflict do nothing;
insert into public.sessions(id,class_id) values ('00000000-0000-0000-0000-00000000a001','00000000-0000-0000-0000-00000000c001') on conflict do nothing;
grant select on public.users, public.classes, public.sessions, public.faculties, public.programmes to authenticated;
grant insert, select on public.attendance to authenticated;
drop table if exists public.sres, public.sexp; create table public.sres(step text, got text); create table public.sexp(step text, want text); grant all on public.sres to public;
create or replace function public.try_sql2(p_step text, p_sql text) returns void language plpgsql as $$ begin execute p_sql; insert into sres values (p_step,'allowed'); exception when others then insert into sres values (p_step,'blocked'); end $$;
grant execute on function public.try_sql2(text,text) to public;
set role authenticated;
set app.uid='00000000-0000-0000-0000-0000000000f1';
select try_sql2('own lecturer, own session', $$insert into attendance(session_id,student_id,status) values ('00000000-0000-0000-0000-00000000a001',gen_random_uuid(),'present')$$);
set app.uid='00000000-0000-0000-0000-0000000000f2';
select try_sql2('other lecturer, not their session', $$insert into attendance(session_id,student_id,status) values ('00000000-0000-0000-0000-00000000a001',gen_random_uuid(),'present')$$);
set app.uid='00000000-0000-0000-0000-0000000000f3';
select try_sql2('administrator', $$insert into attendance(session_id,student_id,status) values ('00000000-0000-0000-0000-00000000a001',gen_random_uuid(),'present')$$);
set app.uid='00000000-0000-0000-0000-0000000000f1';
select try_sql2('no session id', $$insert into attendance(student_id,status) values (gen_random_uuid(),'present')$$);
reset role;
insert into sexp values ('own lecturer, own session','allowed'),('other lecturer, not their session','blocked'),('administrator','allowed'),('no session id','blocked');
do $$ declare bad text; begin
  select string_agg(r.step||': got '||r.got||', wanted '||e.want, '; ') into bad from sres r join sexp e using(step) where r.got is distinct from e.want;
  if bad is not null then raise exception 'staff attendance insert checks failed: %', bad; end if;
  if (select count(*) from sres) <> (select count(*) from sexp) then raise exception 'scenario count mismatch'; end if;
  raise notice 'staff attendance insert: all % checks passed', (select count(*) from sres);
end $$;
