# Getting the real schema, before a second client happens

Prep for the "new institution wants in" scenario: this is the missing
piece in that plan. Of the 18 tables the app actually queries, 13 have no
`CREATE TABLE` anywhere in version control: `users`, `faculties`,
`programmes`, `classes`, `enrollments`, `attendance`, `attendance_appeals`,
`sessions`, `timetable_slots`, `live_qr_sessions`, `fraud_logs`,
`audit_log`, `notifications`. They were built directly in the Supabase
dashboard over time and were never exported to a file. (The other 5 —
`account_deletion_requests`, `announcements`, `course_attendance_caps`,
`support_tickets`, `system_settings` — are already covered, each by its
own `migrate-*.sql` file. `rate_limits` has one too, though it's reached
only via RPC from the Edge Functions, not a direct table query.) A fresh
project for a new client would need that missing base schema, not just the
15 patch files here — and `users` in particular carries real security logic
(see `migrate-harden-users-privilege-escalation.sql`: row-level self-service
restrictions and faculty-scoped access, enforced by a trigger, not just
RLS). That's not something to reconstruct by guessing from `app.js` queries
— getting it wrong could leave a new client's data readable or writable by
the wrong role.

You run this yourself — it either needs your DB password (pg_dump route)
or just your logged-in dashboard session (SQL Editor route), neither of
which should go through Claude.

## Option A — one command, if you have `pg_dump` installed

Gets everything (tables, RLS policies, functions, triggers, indexes) as a
single ready-to-load file, correctly ordered:

```
pg_dump "postgresql://postgres:[YOUR-DB-PASSWORD]@db.[YOUR-PROJECT-REF].supabase.co:5432/postgres" \
  --schema-only --schema=public --no-owner --no-privileges \
  > schema-dump.sql
```

Your connection string and DB password are in Supabase Dashboard → Project
Settings → Database. This is the cleanest option if you have Postgres
client tools (they ship with a full Postgres install, or `brew install
libpq` / `apt install postgresql-client` get just the client).

## Option B — no installs, just the SQL Editor

Copy `export-schema-snapshot.sql` into Supabase Dashboard → SQL Editor →
Run. It's read-only (pure `SELECT` from system catalogs — changes nothing,
safe against production) and returns 11 result sets: columns, primary
keys, foreign keys, constraints, indexes, which tables have RLS on,
every RLS policy verbatim, functions, triggers, sequences, and extensions.
Copy each tab's results out (there's a download button per tab) and save
them — that's your schema snapshot, just less immediately runnable than
Option A's output.

## After either one

1. Save the output somewhere safe — it has no data in it, but it does
   describe your full access-control logic, so treat it like source code,
   not a throwaway file.
2. Turn it into a `schema.sql` you can hand to a brand-new, empty Supabase
   project for the next client (Option A's output already is one; Option
   B's needs assembling into `CREATE TABLE` / `CREATE POLICY` statements
   by hand or with help).
3. Load it into that new project, then load the 15 existing
   `migrate-*.sql` files on top in the order they were written (check
   `git log --follow --oneline -- <file>` per file if the order isn't
   obvious) so the new project ends up exactly where this one is today.
4. Before any client data goes near it: sign in as each role (student,
   lecturer, coordinator, registrar, administrator) against the new
   project and confirm the same things are visible/editable as on the
   live one — the RLS-policy dump from step above tells you what to
   expect, this is just confirming it actually behaves that way.

This only produces the *structure*. No student data, no accounts, nothing
client-identifying is touched or copied by either option — exactly as
intended, since a new client gets a clean project with zero Victoria
University data in it.
