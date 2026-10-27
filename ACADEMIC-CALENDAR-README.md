# Academic calendar (Oct 2026)

## What it is

A shared calendar of holidays, breaks, exam periods and other dated events.
Everyone signed in can see it (Calendar tab for students and lecturers,
a card on the Registrar dashboard, a module on the Administrator dashboard).
Only an Administrator can add or remove entries (Calendar > Edit calendar).

Semester start and end dates stay in System Settings. The calendar holds what
happens inside and between them.

An entry has a type (public holiday, break, exam period, event), a title, a
first and last day, and a "no lectures" flag. Holidays and breaks always have
it set. Exam periods and events can go either way.

## What it changes in the app's numbers

- **Session Delivery Rate (Lecturer Compliance).** "Sessions expected" is now
  counted day by day, from the Term Start Date up to yesterday, using each
  lecturer's confirmed weekly slots, and skipping every no-lectures day.
  Before, it was weekly slots x weeks since the term started, which counted the
  whole current week and had no way to skip a break. If the Term Start Date
  falls inside a semester set in System Settings, counting also stops at that
  semester's end date. Expect rates to move when this goes live (usually up
  mid-week and after breaks). That is the correction, not a fault.
- **Starting a session on a no-lectures day** shows a note. It never blocks:
  a make-up lecture on a holiday is legitimate.
- A banner on the Student and Lecturer home screens when today has an entry.

It does not change attendance percentages, at-risk status or eligibility. A
no-show is only ever marked absent for a session a lecturer actually started,
so there is nothing for the calendar to skip there.

## Deploy

1. Deploy the new `app.js`. Until the migration is run the calendar is simply
   empty (the app treats the missing table as "no entries") and delivery rate
   uses the new day-by-day count with no exclusions.
2. Run `migrate-academic-calendar.sql` in the Supabase SQL Editor. Safe to run
   twice. It is also in the fresh-client SQL bundle.
3. Sign in as an Administrator, open Calendar > Edit calendar, add the term's
   holidays and breaks.

## Phone checks

1. Student: Calendar tab shows the month, today underlined, entries as dots.
   Tap a day: its entries and that student's lectures for that weekday appear.
2. Lecturer: same, with the lecturer's own timetable.
3. Administrator: add a public holiday for tomorrow. A student and a lecturer
   (after reload) see it, and see the banner on the day itself.
4. Student tries to add an entry from the browser console: refused (RLS).
5. Lecturer Compliance before and after adding a break: expected sessions drop
   by the lectures that fell inside it.
6. Lecturer starts a session on a holiday: the note appears, the session runs.
