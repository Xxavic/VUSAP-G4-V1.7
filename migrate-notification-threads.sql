-- Reply threads for notifications.
--
-- Adds three nullable columns so a reply can point at the message it answers:
--   from_role     role of the sender ('student','lecturer','registrar','administrator'),
--                 so the recipient knows who a reply goes to
--   thread_id     id of the first message in the conversation
--   reply_to_id   id of the message this one answers
-- Safe to run more than once. Nothing existing is changed or removed.
--
-- The app keeps working if this has NOT been run: messages still save, but
-- replies show up as separate messages instead of one conversation.

alter table public.notifications
  add column if not exists from_role   text,
  add column if not exists thread_id   uuid,
  add column if not exists reply_to_id uuid;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'notifications_from_role_check') then
    alter table public.notifications
      add constraint notifications_from_role_check
      check (from_role is null or from_role in ('student','lecturer','registrar','administrator'));
  end if;
end $$;

create index if not exists notifications_thread_idx
  on public.notifications (thread_id) where thread_id is not null;

-- AFTER RUNNING: check that students are allowed to insert a notification
-- (a student's reply is an insert). This is not changed here because the
-- notifications policies are not in version control. Run:
--
--   select policyname, cmd, roles, with_check
--   from pg_policies where tablename = 'notifications';
--
-- If there is no INSERT policy that lets a signed-in student insert, replies
-- from students will fail to save (the app tells the sender). A minimal fix:
--
--   create policy "signed-in users can send a reply"
--     on public.notifications for insert to authenticated
--     with check (type = 'reply' and from_role is not null);
