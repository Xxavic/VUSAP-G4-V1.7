-- ============================================================================
-- RLS AUDIT — read-only, safe to run on the LIVE project.
--
-- Run in Supabase Dashboard -> SQL Editor. It only reads system catalogs.
-- Result 1 is the one that matters: one row per table with a plain verdict.
-- Result 2 lists every policy so the verdicts can be checked by eye.
--
-- Verdicts (worst first):
--   NO RLS           row level security is off: anyone with the public key can
--                    read AND write every row.
--   OPEN TO ANYONE   a policy lets the anon (not signed in) role in, or a
--                    signed-in user do anything with a condition of just true.
--   OPEN (signed-in) a signed-in user of ANY role can reach every row. Fine for
--                    reference data (faculties) but wrong for private data.
--   NO POLICIES      RLS is on and nothing allows anything: locked (the app
--                    would break, but it is safe).
--   scoped           policies carry a real condition.
-- ============================================================================

with t as (
  select c.oid, c.relname as table_name, c.relrowsecurity as rls_on
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
),
p as (
  select
    pol.polrelid,
    pol.polname,
    case pol.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE'
                    when 'd' then 'DELETE' else 'ALL' end as cmd,
    (select coalesce(string_agg(case when r = 0 then 'public' else (select rolname from pg_roles where oid = r) end, ', '), 'public')
       from unnest(pol.polroles) as r) as roles,
    pg_get_expr(pol.polqual, pol.polrelid) as using_expr,
    pg_get_expr(pol.polwithcheck, pol.polrelid) as check_expr
  from pg_policy pol
),
flag as (
  select
    p.*,
    (roles ~ '(^|, )(public|anon)(,|$)') as for_anon,
    (coalesce(using_expr, 'true') in ('true', '(true)') and coalesce(check_expr, 'true') in ('true', '(true)')) as always_true
  from p
)
select
  t.table_name,
  t.rls_on,
  case
    when not t.rls_on then 'NO RLS'
    when exists (select 1 from flag f where f.polrelid = t.oid and f.for_anon) then 'OPEN TO ANYONE'
    when exists (select 1 from flag f where f.polrelid = t.oid and f.always_true and f.cmd <> 'SELECT') then 'OPEN (signed-in) writes'
    when exists (select 1 from flag f where f.polrelid = t.oid and f.always_true and f.cmd = 'SELECT') then 'OPEN (signed-in) reads'
    when not exists (select 1 from p where p.polrelid = t.oid) then 'NO POLICIES'
    else 'scoped'
  end as verdict,
  (select count(*) from p where p.polrelid = t.oid) as policies
from t
order by
  case
    when not t.rls_on then 0
    when exists (select 1 from flag f where f.polrelid = t.oid and f.for_anon) then 1
    when exists (select 1 from flag f where f.polrelid = t.oid and f.always_true and f.cmd <> 'SELECT') then 2
    when exists (select 1 from flag f where f.polrelid = t.oid and f.always_true) then 3
    else 4
  end,
  t.table_name;

-- 2) Every policy, for checking the verdicts above.
select
  c.relname as table_name, p.polname as policy, 
  case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end as cmd,
  (select coalesce(string_agg(case when r = 0 then 'public' else (select rolname from pg_roles where oid = r) end, ', '), 'public') from unnest(p.polroles) as r) as roles,
  pg_get_expr(p.polqual, p.polrelid) as using_expr,
  pg_get_expr(p.polwithcheck, p.polrelid) as with_check
from pg_policy p
join pg_class c on c.oid = p.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
order by c.relname, p.polcmd, p.polname;

-- 3) Functions that run with their owner's rights (security definer). These
--    bypass RLS by design, so each one should check who is calling.
select p.proname as function, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
order by p.proname;
