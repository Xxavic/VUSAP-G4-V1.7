# Semester dates, Academic Year Archives, and graduation

Three related features, one migration, built together because the later
two depend on the first.

## 1. Semester date ranges (System Settings)

An Administrator sets Semester 1 start/end and Semester 2 start/end once
per academic year, in System Settings, right under Term Start Date.
`semesterForDate(dateISO)` in app.js is the one place these get read --
every screen that splits a student's attendance into "Semester 1" /
"Semester 2" now agrees, because they all call the same function.

Wired into:
- **My Students -> a student's attendance detail** (Lecturer): each
  class's day-by-day history is now grouped by semester instead of one
  continuous list.
- **Attendance Records -> a student's drill-down** (Registrar/Admin): this
  screen used to label every record with whatever the student's profile
  CURRENTLY says their semester is -- its own old code comment admitted
  this was a stand-in, not accurate per record. Now it groups by the
  actual date each record happened on.

Both degrade gracefully: until you set the date ranges (or for any record
whose date falls outside both of them), they fall back to exactly what
they showed before this feature existed -- no broken/empty states.

## 2. Academic Year Archives

New screen (**Academic Year Archives**, reachable from both the
Administrator and Registrar dashboards): manual "End Academic Year"
button, plus a list of every year already archived.

**Manual only.** Nothing happens automatically. When you click "End
Academic Year", it archives whatever the current Academic Year field says
in System Settings (e.g. "2025/2026") as of today, and **deletes
nothing** -- every existing record stays exactly where it already lives.
What actually changes:

- The Lecturer's **My Students** screen starts scoping to the current
  year only, from the day after you ended the previous one. A lecturer
  teaching the same course again next year won't see last year's students
  mixed into this year's roster or attendance percentages.
- That past year's full student + lecturer attendance data is still
  there, browsable any time, but only from the Academic Year Archives
  screen -- which only an Administrator or Registrar can open (enforced
  by RLS, not just hidden in the UI).
- A student's own "My Attendance" is untouched by any of this, on
  purpose -- they keep their full history, across every year, in their
  own account for as long as it exists.

After ending a year, update the **Academic Year** field in System
Settings to the new year's label before anyone ends the next one --
`endAcademicYear()` refuses to archive the same label twice.

## 3. "Mark as Graduated"

New button next to Suspend Account on a student's account detail (Admin/
Registrar only, same as Suspend). Suspends the account -- the same
outcome as a regular suspension -- but records `graduated_at` separately,
so a graduation is never confused with e.g. a misconduct suspension in
the audit log or a future report. Reactivating a graduated account clears
`graduated_at` too, in case it was marked by mistake.

### A pre-existing bug this also fixes

While building this, found that **Suspend Account / Reactivate Account
never actually worked for real accounts.** They only ever mutated an
in-memory mock object (`USERS[personId]`) -- for any live account with no
matching hardcoded demo credential (i.e. almost every real student or
lecturer), clicking "Suspend Account" did *nothing at all*, not even an
error. And even for the handful of demo accounts where it did do
something, it never reached the live `users.status` column, even though
that column already exists and `handleLogin()` already checks it -- so a
"suspended" account could still sign in from any other device or browser.

Fixed as part of this change: suspend/reactivate now writes
`users.status` live (keyed by `university_id`, no schema change needed
for this part), with an honest toast if the write fails ("...was NOT
actually suspended") instead of silently pretending it worked.

## Deploy order

1. **Run `migrate-academic-year-archive.sql`** (Supabase SQL Editor).
   Adds the 4 semester-date columns, the new `academic_year_archives`
   table + RLS, and `users.graduated_at`.
2. **Deploy the updated `app.js`.**

Nothing here has a deploy-ordering safety net like the live-session
class_id fix did -- these are lower-stakes (settings and an admin screen,
not the live check-in write path), so run the migration first and there's
nothing to worry about.

## What this does not do

- Doesn't touch `RECORDS`/`attendance`/`sessions` data at all -- archiving
  a year never deletes, moves, or exports anything to a file. "Archive"
  here means a marker + a filter, not a data migration.
- Doesn't scope the Registrar's own Attendance Records / Data Analytics
  screens to current-year-only -- only the Lecturer's My Students does,
  since that's the screen this whole feature grew out of. Say if you want
  the Registrar-facing screens scoped the same way too.
- Doesn't infer "graduated" automatically from a student finishing their
  final year -- it's a deliberate, one-at-a-time action, same as Suspend.
