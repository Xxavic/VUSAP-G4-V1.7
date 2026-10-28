\set ON_ERROR_STOP on
-- Old, permissive state first (what the live database has today).
alter table public.users add column if not exists university_id text;
drop table if exists public.notifications, public.audit_log, public.fraud_logs cascade;
create table public.notifications(id uuid primary key default gen_random_uuid(), recipient_role text not null, recipient_id text, type text not null, title text not null, body text not null, from_name text, from_id text, from_role text);
create table public.audit_log(id uuid primary key default gen_random_uuid(), actor text, action text not null, detail text, actor_supabase_id uuid default auth.uid());
create table public.fraud_logs(id uuid primary key default gen_random_uuid(), student text not null, reason text not null, severity text not null);
alter table public.notifications enable row level security; alter table public.audit_log enable row level security; alter table public.fraud_logs enable row level security;
create policy "Authenticated users send notifications" on public.notifications for insert to public with check (true);
create policy "Authenticated users write audit log" on public.audit_log for insert to public with check (true);
create policy "Authenticated users insert fraud logs" on public.fraud_logs for insert to public with check (true);
grant select, insert on public.notifications, public.audit_log, public.fraud_logs to authenticated;
grant select on public.users to authenticated;
delete from public.users where id in ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000e3');
insert into public.users(id,name,role,university_id) values ('00000000-0000-0000-0000-0000000000e2','Lect','lecturer','VU-LEC-101'),('00000000-0000-0000-0000-0000000000e3','Stud','student','VU-CSF-1');
\i migrate-tighten-inserts.sql
\i migrate-tighten-inserts.sql
drop table if exists public.nres, public.nexp; create table public.nres(step text, got text); create table public.nexp(step text, want text); grant all on public.nres to public;
create or replace function public.try_sql(p_step text, p_sql text) returns void language plpgsql as $$ begin execute p_sql; insert into nres values (p_step,'allowed'); exception when others then insert into nres values (p_step,'blocked'); end $$;
grant execute on function public.try_sql(text,text) to public;
set role authenticated;
set app.uid='00000000-0000-0000-0000-0000000000e3';
select try_sql('student -> lecturer as self', $$insert into notifications(recipient_role,type,title,body,from_id,from_role) values ('lecturer','reply','t','b','VU-CSF-1','student')$$);
select try_sql('student -> student', $$insert into notifications(recipient_role,type,title,body,from_id,from_role) values ('student','general','t','b','VU-CSF-1','student')$$);
select try_sql('student as someone else', $$insert into notifications(recipient_role,type,title,body,from_id,from_role) values ('lecturer','reply','t','b','VU-LEC-101','lecturer')$$);
select try_sql('student claims admin role', $$insert into notifications(recipient_role,type,title,body,from_id,from_role) values ('registrar','general','t','b','VU-CSF-1','administrator')$$);
select try_sql('student system alert to registrar', $$insert into notifications(recipient_role,type,title,body,from_id) values ('registrar','fraudFlagged','t','b','system')$$);
select try_sql('oversize body', $$insert into notifications(recipient_role,type,title,body) values ('lecturer','general','t',repeat('x',4001))$$);
select try_sql('audit as self (default)', $$insert into audit_log(actor,action) values ('VU-CSF-1','login')$$);
select try_sql('audit forged actor', $$insert into audit_log(actor,action,actor_supabase_id) values ('VU-LEC-101','x','00000000-0000-0000-0000-0000000000e2')$$);
select try_sql('fraud flag (stamped)', $$insert into fraud_logs(student,reason,severity) values ('VU-CSF-1','shared device','high')$$);
select try_sql('fraud forged reporter', $$insert into fraud_logs(student,reason,severity,reported_by) values ('VU-CSF-1','x','high','00000000-0000-0000-0000-0000000000e2')$$);
set app.uid='00000000-0000-0000-0000-0000000000e2';
select try_sql('lecturer -> student as self', $$insert into notifications(recipient_role,type,title,body,from_id,from_role) values ('student','reschedule','t','b','VU-LEC-101','lecturer')$$);
select try_sql('lecturer system notice to student', $$insert into notifications(recipient_role,type,title,body,from_id) values ('student','reschedule','t','b','system')$$);
select try_sql('lecturer as someone else', $$insert into notifications(recipient_role,type,title,body,from_id) values ('student','general','t','b','VU-ADM-001')$$);
reset role;
insert into nexp values ('student -> lecturer as self','allowed'),('student -> student','blocked'),('student as someone else','blocked'),('student claims admin role','blocked'),('student system alert to registrar','allowed'),('oversize body','blocked'),('audit as self (default)','allowed'),('audit forged actor','blocked'),('fraud flag (stamped)','allowed'),('fraud forged reporter','blocked'),('lecturer -> student as self','allowed'),('lecturer system notice to student','allowed'),('lecturer as someone else','blocked');
do $$ declare bad text; begin
  select string_agg(r.step||': got '||r.got||', wanted '||e.want, '; ') into bad from nres r join nexp e using(step) where r.got is distinct from e.want;
  if bad is not null then raise exception 'tighten-inserts checks failed: %', bad; end if;
  if (select count(*) from nres) <> (select count(*) from nexp) then raise exception 'scenario count mismatch'; end if;
  if (select count(*) from fraud_logs where reported_by = '00000000-0000-0000-0000-0000000000e3') <> 1 then raise exception 'fraud flag was not stamped with its author'; end if;
  raise notice 'tighten inserts: all % checks passed', (select count(*) from nres);
end $$;
