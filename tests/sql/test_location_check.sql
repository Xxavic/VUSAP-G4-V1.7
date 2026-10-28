\set ON_ERROR_STOP on
-- stand-ins for tables the real database already has
drop table if exists public.system_settings cascade;
create table public.system_settings(id int primary key);
insert into public.system_settings values (1);
drop table if exists public.fraud_logs cascade;
create table public.fraud_logs(id uuid primary key default gen_random_uuid(), student text not null, reason text not null, severity text not null, course text, device_id text, created_at timestamptz default now());
drop table if exists public.attendance_locations, public.live_qr_locations cascade;
\i migrate-location-check.sql
\i migrate-location-check.sql
delete from public.users where id::text like '00000000-0000-0000-0000-0000000000c%';
insert into public.users(id,name,role) values
 ('00000000-0000-0000-0000-0000000000c1','Lecturer','lecturer'),
 ('00000000-0000-0000-0000-0000000000c2','Other Lecturer','lecturer'),
 ('00000000-0000-0000-0000-0000000000c3','Near Student','student'),
 ('00000000-0000-0000-0000-0000000000c4','Far Student','student'),
 ('00000000-0000-0000-0000-0000000000c5','Fuzzy Student','student'),
 ('00000000-0000-0000-0000-0000000000c6','Denied Student','student'),
 ('00000000-0000-0000-0000-0000000000c7','Absent Student','student'),
 ('00000000-0000-0000-0000-0000000000c8','Admin','administrator');
delete from public.live_qr_sessions where id = '00000000-0000-0000-0000-00000000b001';
insert into public.live_qr_sessions(id,course_code,lecturer_id) values ('00000000-0000-0000-0000-00000000b001','CSC1','00000000-0000-0000-0000-0000000000c1');
delete from public.attendance where live_broadcast_id = '00000000-0000-0000-0000-00000000b001';
insert into public.attendance(live_broadcast_id,student_id,student_name,status,device_id) values
 ('00000000-0000-0000-0000-00000000b001','00000000-0000-0000-0000-0000000000c3','Near Student','present','dev3'),
 ('00000000-0000-0000-0000-00000000b001','00000000-0000-0000-0000-0000000000c4','Far Student','present','dev4'),
 ('00000000-0000-0000-0000-00000000b001','00000000-0000-0000-0000-0000000000c5','Fuzzy Student','present','dev5'),
 ('00000000-0000-0000-0000-00000000b001','00000000-0000-0000-0000-0000000000c6','Denied Student','present','dev6');
grant select on public.users, public.live_qr_sessions, public.attendance, public.system_settings, public.fraud_logs, public.attendance_locations, public.live_qr_locations to authenticated;
drop table if exists public.lres, public.lexp; create table public.lres(step text, got text); create table public.lexp(step text, want text); grant all on public.lres to public;
-- lat/lng reference: 0.3476, 32.5825.  0.00045 deg lat ~ 50 m, 0.0036 ~ 400 m, 0.045 ~ 5 km
set role authenticated;
set app.uid='00000000-0000-0000-0000-0000000000c3';
insert into lres select 'off: student report skipped', (record_checkin_location('00000000-0000-0000-0000-00000000b001', 0.3476, 32.5825, 10))->>'skipped';
reset role;
insert into lres select 'off: nothing stored', count(*)::text from attendance_locations;
update system_settings set location_check_mode = 'flag' where id = 1;
set role authenticated;
set app.uid='00000000-0000-0000-0000-0000000000c2';
insert into lres select 'other lecturer cannot set position', (set_session_location('00000000-0000-0000-0000-00000000b001', 0.3476, 32.5825, 10))->>'reason';
set app.uid='00000000-0000-0000-0000-0000000000c3';
insert into lres select 'student cannot set position', (set_session_location('00000000-0000-0000-0000-00000000b001', 0.3476, 32.5825, 10))->>'reason';
set app.uid='00000000-0000-0000-0000-0000000000c1';
insert into lres select 'lecturer sets position', (set_session_location('00000000-0000-0000-0000-00000000b001', 0.3476, 32.5825, 10))->>'ok';
insert into lres select 'bad coordinates refused', (set_session_location('00000000-0000-0000-0000-00000000b001', 123, 32.5825, 10))->>'reason';
set app.uid='00000000-0000-0000-0000-0000000000c3';
insert into lres select 'near student not flagged', (record_checkin_location('00000000-0000-0000-0000-00000000b001', 0.34805, 32.5825, 10))->>'flagged';
set app.uid='00000000-0000-0000-0000-0000000000c4';
insert into lres select 'far student flagged', (record_checkin_location('00000000-0000-0000-0000-00000000b001', 0.3926, 32.5825, 15))->>'flagged';
set app.uid='00000000-0000-0000-0000-0000000000c5';
insert into lres select 'poor GPS forgiven', (record_checkin_location('00000000-0000-0000-0000-00000000b001', 0.3512, 32.5825, 300))->>'flagged';
set app.uid='00000000-0000-0000-0000-0000000000c6';
insert into lres select 'denied is recorded, not flagged', (record_checkin_location('00000000-0000-0000-0000-00000000b001', null, null, null))->>'located';
set app.uid='00000000-0000-0000-0000-0000000000c7';
insert into lres select 'no check-in, nothing recorded', (record_checkin_location('00000000-0000-0000-0000-00000000b001', 0.3476, 32.5825, 10))->>'reason';
set app.uid='00000000-0000-0000-0000-0000000000c3';
do $$ begin begin perform 1 from public.attendance_locations; insert into lres values ('student reads distances','allowed'); exception when others then insert into lres values ('student reads distances','blocked'); end; end $$;
insert into lres select 'student sees no distance rows', count(*)::text from attendance_locations;
insert into lres select 'student sees no lecturer position', count(*)::text from live_qr_locations;
do $$ begin begin perform public.purge_checkin_locations(1); insert into lres values ('student purges','allowed'); exception when others then insert into lres values ('student purges','blocked'); end; end $$;
set app.uid='00000000-0000-0000-0000-0000000000c8';
insert into lres select 'admin sees all four', count(*)::text from attendance_locations;
reset role;
insert into lres select 'fraud entry only for far student', string_agg(student, ',') from fraud_logs;
insert into lres select 'fraud entry names the distance', (reason like 'Checked in about 50__ m from the lecturer (limit 150 m)')::text from fraud_logs where student = 'Far Student';
insert into lres select 'no coordinate columns stored', count(*)::text from information_schema.columns where table_name = 'attendance_locations' and column_name in ('lat','lng','latitude','longitude');
insert into lres select 'default is off', (select column_default from information_schema.columns where table_name='system_settings' and column_name='location_check_mode');
insert into lexp values
 ('off: student report skipped','true'),('off: nothing stored','0'),
 ('other lecturer cannot set position','not_your_session'),('student cannot set position','not_your_session'),
 ('lecturer sets position','true'),('bad coordinates refused','bad_position'),
 ('near student not flagged','false'),('far student flagged','true'),('poor GPS forgiven','false'),
 ('denied is recorded, not flagged','false'),('no check-in, nothing recorded','no_checkin'),
 ('student reads distances','allowed'),('student sees no distance rows','0'),
 ('student sees no lecturer position','0'),('student purges','blocked'),
 ('admin sees all four','4'),('fraud entry only for far student','Far Student'),
 ('fraud entry names the distance','true'),('no coordinate columns stored','0'),('default is off','''off''::text');
do $$ declare bad text; begin
  select string_agg(r.step||': got '||coalesce(r.got,'null')||', wanted '||e.want, '; ') into bad from lres r join lexp e using(step) where r.got is distinct from e.want;
  if bad is not null then raise exception 'location check tests failed: %', bad; end if;
  if (select count(*) from lres) <> (select count(*) from lexp) then raise exception 'scenario count mismatch: % vs %', (select count(*) from lres), (select count(*) from lexp); end if;
  raise notice 'location check: all % checks passed', (select count(*) from lres);
end $$;
