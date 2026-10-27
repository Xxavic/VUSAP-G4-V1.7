-- Lets a signed-in user (in practice: a Class Coordinator) save a reply, and
-- nothing else, into notifications.
--
-- Run AFTER migrate-notification-threads.sql (this uses its reply_to_id and
-- from_role columns). Safe to run more than once.
--
-- A reply is accepted only when all of these hold, checked on the server:
--   - the sender is staff or a Class Coordinator (users.is_class_coordinator).
--     Other students only receive messages and raise concerns via Support.
--   - it answers a person's message or a reply (type 'general' or 'reply'),
--     never an announcement
--   - the sender has saved fewer than 10 replies in the last hour
--   - it answers a real message (reply_to_id) that was addressed to the
--     sender: directly (recipient_id = their university ID) or as a
--     broadcast to their whole role (recipient_id null, same recipient_role)
--   - it goes to the person who wrote that message (recipient_id = the
--     message's from_id), with that person's real role
--   - from_id, from_role and from_name are the sender's own, from users
--     (so nobody can reply "as" the Registrar or as another student)
--   - recipient_id is set, so a reply can never become a broadcast
--
-- can_send_reply() is security definer so the check can read users and
-- notifications rows the sender's own RLS would hide (the other person's
-- users row, a broadcast's row). It returns only true/false.
--
-- Uses notifications.created_at (set by the database) for the hourly count,
-- so a client cannot dodge the limit by sending its own date.
--
-- This ADDS an insert path; policies are OR'd. If an existing insert policy
-- already lets students insert any row (see the check at the bottom), this
-- does not tighten it, and that policy needs narrowing on its own.
-- Do NOT also create the looser "type = 'reply' and from_role is not null"
-- policy suggested in earlier notes.

create or replace function public.can_send_reply(
  p_reply_to_id    uuid,
  p_recipient_id   text,
  p_recipient_role text,
  p_from_id        text,
  p_from_role      text,
  p_from_name      text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.users me
    join public.notifications parent on parent.id = p_reply_to_id
    join public.users them on them.university_id = p_recipient_id
    where me.id = auth.uid()
      and me.university_id = p_from_id
      and me.role = p_from_role
      and me.name is not distinct from p_from_name
      and (me.role <> 'student' or me.is_class_coordinator)
      and parent.type in ('general', 'reply')
      and parent.from_id = p_recipient_id
      and them.role = p_recipient_role
      and (parent.recipient_id = me.university_id
           or (parent.recipient_id is null and parent.recipient_role = me.role))
      and (select count(*) from public.notifications sent
           where sent.from_id = me.university_id
             and sent.type = 'reply'
             and sent.created_at > now() - interval '1 hour') < 10
  );
$$;

revoke all on function public.can_send_reply(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.can_send_reply(uuid, text, text, text, text, text) to authenticated;

drop policy if exists "notifications_insert_reply" on public.notifications;
create policy "notifications_insert_reply"
  on public.notifications
  for insert
  to authenticated
  with check (
    type = 'reply'
    and recipient_id is not null
    and public.can_send_reply(reply_to_id, recipient_id, recipient_role, from_id, from_role, from_name)
  );

-- Checks (run after):
--   1. Lists every insert policy on notifications. "notifications_insert_reply"
--      should be there. Read the with_check of any OTHER insert policy: if one
--      lets a student insert anything (e.g. with_check is just "true"), replies
--      were already open and that policy is the one to narrow.
--        select policyname, roles, with_check
--        from pg_policies
--        where tablename = 'notifications' and cmd = 'INSERT';
--   2. As a Class Coordinator, in the app: reply to a message a lecturer sent
--      you. It saves ("Reply sent"). The 11th reply within an hour is refused.
--   3. As a student who is NOT a coordinator: no Reply button, a "contact
--      Support" line instead. From the browser console, inserting a type
--      'reply' row is refused (42501).
--   4. As a Class Coordinator, from the browser console: a reply to an
--      announcement, a reply with recipient_id null, or one with from_name
--      'Registrar' is refused (42501).
