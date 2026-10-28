\set ON_ERROR_STOP on
insert into users values ('00000000-0000-0000-0000-00000000000a','Lect','lecturer',false),('00000000-0000-0000-0000-0000000000b1','S1','student',false),('00000000-0000-0000-0000-0000000000b2','S2','student',false),('00000000-0000-0000-0000-0000000000b3','S3','student',false),('00000000-0000-0000-0000-0000000000c1','Other','lecturer',false),('00000000-0000-0000-0000-0000000000e1','Coord','student',true);
insert into classes(id,code,teacher_id) values ('11111111-1111-1111-1111-111111111111','CSC1','00000000-0000-0000-0000-00000000000a');
insert into enrollments select u.id,'11111111-1111-1111-1111-111111111111' from users u where role='student';
insert into live_qr_sessions(id,course_code,course_name,class_id,lecturer_id,token,pin) values ('22222222-2222-2222-2222-222222222222','CSC1','Intro','11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-00000000000a','QR-AAA','111111');
create temp table res(step text, got text);
-- 1. a student cannot set the pin; another lecturer cannot; owner can
set app.uid='00000000-0000-0000-0000-0000000000b1';
insert into res select 'student set_backup_pin', public.set_backup_pin('22222222-2222-2222-2222-222222222222','123456',60)->>'reason';
set app.uid='00000000-0000-0000-0000-0000000000c1';
insert into res select 'other lecturer set_backup_pin', public.set_backup_pin('22222222-2222-2222-2222-222222222222','123456',60)->>'reason';
set app.uid='00000000-0000-0000-0000-00000000000a';
insert into res select 'bad pin', public.set_backup_pin('22222222-2222-2222-2222-222222222222','12ab56',60)->>'reason';
insert into res select 'bad lifetime', public.set_backup_pin('22222222-2222-2222-2222-222222222222','123456',9999)->>'reason';
insert into res select 'owner set ok', (public.set_backup_pin('22222222-2222-2222-2222-222222222222','222222',60)->>'ok');
-- 2. fresh pin works for a student
set app.uid='00000000-0000-0000-0000-0000000000b1';
insert into res select 'S1 fresh pin', (public.check_in_to_broadcast('22222222-2222-2222-2222-222222222222',null,'222222','dev1',false)->>'ok');
-- 3. old initial pin no longer works (replaced)
set app.uid='00000000-0000-0000-0000-0000000000b2';
insert into res select 'S2 old pin 111111', (public.check_in_to_broadcast('22222222-2222-2222-2222-222222222222',null,'111111','dev2',false)->>'reason');
-- 4. expire the pin (move time) -> rejected, even offline
reset role; update live_qr_secrets set pin_expires_at = now() - interval '1 second';
set app.uid='00000000-0000-0000-0000-0000000000b2';
insert into res select 'S2 expired pin online', (public.check_in_to_broadcast('22222222-2222-2222-2222-222222222222',null,'222222','dev2',false)->>'reason');
insert into res select 'S2 expired pin offline flag', (public.check_in_to_broadcast('22222222-2222-2222-2222-222222222222',null,'222222','dev2',true)->>'reason');
-- 5. QR still works while pin expired
insert into res select 'S2 QR still works', (public.check_in_to_broadcast('22222222-2222-2222-2222-222222222222','QR-AAA',null,'dev2',false)->>'ok');
-- 6. lecturer retires pin at once (seconds 0) and sets unseen one
set app.uid='00000000-0000-0000-0000-00000000000a';
insert into res select 'retire now', (public.set_backup_pin('22222222-2222-2222-2222-222222222222','999999',0)->>'ok');
set app.uid='00000000-0000-0000-0000-0000000000b3';
insert into res select 'S3 retired pin', (public.check_in_to_broadcast('22222222-2222-2222-2222-222222222222',null,'999999','dev3',false)->>'reason');
-- 7. no expiry set (PIN written by an older app): 135 s from pin_set_at
reset role; update live_qr_secrets set pin='333333', pin_expires_at=null, pin_set_at=now() - interval '200 seconds';
set app.uid='00000000-0000-0000-0000-0000000000b3';
insert into res select 'S3 null expiry, old pin_set_at', (public.check_in_to_broadcast('22222222-2222-2222-2222-222222222222',null,'333333','dev3',false)->>'reason');
reset role; update live_qr_secrets set pin_set_at=null;
set app.uid='00000000-0000-0000-0000-0000000000b3';
insert into res select 'S3 null expiry, null pin_set_at', (public.check_in_to_broadcast('22222222-2222-2222-2222-222222222222',null,'333333','dev3',false)->>'reason');
-- a PIN written onto the broadcast row clears the set_backup_pin expiry and starts the 135 s
set app.uid='00000000-0000-0000-0000-00000000000a';
insert into res select 'retire again', (public.set_backup_pin('22222222-2222-2222-2222-222222222222','888888',0)->>'ok');
reset role; update live_qr_sessions set pin='555555';
insert into res select 'row write clears expiry', (select (pin_expires_at is null and pin_set_at > now() - interval '5 seconds')::text from live_qr_secrets);
set app.uid='00000000-0000-0000-0000-0000000000b3';
insert into res select 'S3 row-written pin', (public.check_in_to_broadcast('22222222-2222-2222-2222-222222222222',null,'555555','dev3',false)->>'ok');
-- 7b. get_broadcast_secrets: the PIN goes to the owner only, never a coordinator
reset role; update live_qr_sessions set coordinator_authorized=true;
set app.uid='00000000-0000-0000-0000-0000000000e1';
insert into res select 'coordinator token', (public.get_broadcast_secrets('22222222-2222-2222-2222-222222222222')->>'token');
insert into res select 'coordinator pin', coalesce(public.get_broadcast_secrets('22222222-2222-2222-2222-222222222222')->>'pin', 'null');
set app.uid='00000000-0000-0000-0000-00000000000a';
insert into res select 'owner pin', (public.get_broadcast_secrets('22222222-2222-2222-2222-222222222222')->>'pin');
-- 8. ended broadcast cannot be given a pin
reset role; update live_qr_sessions set active=false;
set app.uid='00000000-0000-0000-0000-00000000000a';
insert into res select 'ended set_backup_pin', public.set_backup_pin('22222222-2222-2222-2222-222222222222','444444',60)->>'reason';


create temp table expected(step text, want text);
insert into expected values
('student set_backup_pin','not_owner'),
('other lecturer set_backup_pin','not_owner'),
('bad pin','bad_pin'),
('bad lifetime','bad_lifetime'),
('owner set ok','true'),
('S1 fresh pin','true'),
('S2 old pin 111111','bad_code'),
('S2 expired pin online','bad_code'),
('S2 expired pin offline flag','bad_code'),
('S2 QR still works','true'),
('retire now','true'),
('S3 retired pin','bad_code'),
('S3 null expiry, old pin_set_at','bad_code'),
('S3 null expiry, null pin_set_at','bad_code'),
('retire again','true'),
('row write clears expiry','true'),
('S3 row-written pin','true'),
('coordinator token','QR-AAA'),
('coordinator pin','null'),
('owner pin','555555'),
('ended set_backup_pin','ended');
do $$
declare bad text;
begin
  select string_agg(r.step || ': got ' || coalesce(r.got,'null') || ', wanted ' || e.want, '; ') into bad
  from res r join expected e using (step) where r.got is distinct from e.want;
  if bad is not null then raise exception 'backup pin expiry checks failed: %', bad; end if;
  if (select count(*) from res) <> (select count(*) from expected) then raise exception 'scenario count mismatch'; end if;
  raise notice 'backup pin expiry: all % checks passed', (select count(*) from res);
end $$;
