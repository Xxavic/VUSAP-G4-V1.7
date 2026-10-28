\set ON_ERROR_STOP on
insert into users values ('00000000-0000-0000-0000-0000000000d1','Admin','administrator',false),('00000000-0000-0000-0000-0000000000d2','Lect','lecturer',false),('00000000-0000-0000-0000-0000000000d3','Stud','student',false)
  on conflict do nothing;
create table public.qres(step text, got text); grant all on public.qres to public;
grant select, insert, update, delete on public.quick_messages to authenticated;
grant select on public.users to authenticated;
insert into qres select 'seeded six', count(*)::text from public.quick_messages;
set role authenticated;
set app.uid='00000000-0000-0000-0000-0000000000d2';
insert into qres select 'lecturer can read', count(*)::text from public.quick_messages;
do $$ begin begin insert into public.quick_messages(label,title,body) values ('x','y','z'); insert into qres values ('lecturer insert','allowed'); exception when others then insert into qres values ('lecturer insert','blocked'); end; end $$;
set app.uid='00000000-0000-0000-0000-0000000000d3';
insert into qres select 'student can read', count(*)::text from public.quick_messages;
set app.uid='00000000-0000-0000-0000-0000000000d1';
do $$ begin begin insert into public.quick_messages(label,title,body) values ('Admin one','t','b'); insert into qres values ('admin insert','allowed'); exception when others then insert into qres values ('admin insert','blocked'); end; end $$;
do $$ declare n int; begin update public.quick_messages set body='edited' where label='Admin one'; get diagnostics n = row_count; insert into qres values ('admin update', n::text); end $$;
do $$ declare n int; begin delete from public.quick_messages where label='Admin one'; get diagnostics n = row_count; insert into qres values ('admin delete', n::text); end $$;
set app.uid='00000000-0000-0000-0000-0000000000d2';
do $$ declare n int; begin update public.quick_messages set body='hacked' where label='Class cancelled'; get diagnostics n = row_count; insert into qres values ('lecturer update', n::text); end $$;
reset role;
create table public.qexp(step text, want text);
insert into qexp values ('seeded six','6'),('lecturer can read','6'),('lecturer insert','blocked'),('student can read','0'),('admin insert','allowed'),('admin update','1'),('admin delete','1'),('lecturer update','0');
do $$ declare bad text; begin
  select string_agg(r.step||': got '||coalesce(r.got,'null')||', wanted '||e.want, '; ') into bad from qres r join qexp e using(step) where r.got is distinct from e.want;
  if bad is not null then raise exception 'quick message checks failed: %', bad; end if;
  if (select count(*) from qres) <> (select count(*) from qexp) then raise exception 'scenario count mismatch'; end if;
  raise notice 'quick messages: all % checks passed', (select count(*) from qres);
end $$;
