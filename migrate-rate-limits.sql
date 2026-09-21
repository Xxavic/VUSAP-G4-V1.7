-- Database-backed rate limiting for the signed-out Edge Functions
-- (request-password-reset, email-login).
--
-- Why: both functions are callable by anyone holding the public anon key.
-- request-password-reset sends an email per call; email-login accepts
-- unlimited password guesses. Edge Function instances are ephemeral, so an
-- in-memory counter resets whenever the instance recycles — the counter has
-- to live in the database to actually hold.
--
-- How it works: rate_limit_hit(key, max, window) atomically counts calls per
-- key inside a rolling window and returns TRUE while the caller is within the
-- limit. rate_limit_reset(key) clears a key (used to forgive a user after a
-- successful login). Only the service role (the Edge Functions) can call
-- either function or read the table — the browser cannot, so nobody can reset
-- their own counter or read anyone else's keys.
--
-- Safe to run more than once. Deploy order doesn't matter: the functions
-- fail open (log a warning, allow the request) if this isn't applied yet.

create table if not exists public.rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  hits int not null default 0
);

-- RLS on with NO policies = no access for anon/authenticated at all.
alter table public.rate_limits enable row level security;

create or replace function public.rate_limit_hit(
  p_key text,
  p_max int,
  p_window_seconds int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hits int;
begin
  insert into public.rate_limits as r (key, window_start, hits)
  values (p_key, now(), 1)
  on conflict (key) do update
    set hits = case
          when r.window_start < now() - make_interval(secs => p_window_seconds) then 1
          else r.hits + 1
        end,
        window_start = case
          when r.window_start < now() - make_interval(secs => p_window_seconds) then now()
          else r.window_start
        end
  returning hits into v_hits;

  -- Opportunistic housekeeping so the table can't grow without bound.
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
  end if;

  return v_hits <= p_max;
end;
$$;

create or replace function public.rate_limit_reset(p_key text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.rate_limits where key = p_key;
$$;

revoke all on function public.rate_limit_hit(text, int, int) from public, anon, authenticated;
revoke all on function public.rate_limit_reset(text) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, int, int) to service_role;
grant execute on function public.rate_limit_reset(text) to service_role;
