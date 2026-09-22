# Getting existing students their courses back

This is for students who were already registered before the auto-enrollment
fix went in — they have real accounts but, like the one you reported, an
empty timetable and no way to scan a QR code, because nothing ever wrote
their `enrollments` rows. Going forward, new registrations handle this
automatically (see the code comment on `autoEnrollStudentInCourses()` in
`app.js`). This is the one-time catch-up for everyone registered before that.

## Order matters

1. **Run `migrate-classes-year-column.sql`** (Supabase SQL Editor, or however
   you run the other `migrate-*.sql` files in this repo). Adds a `year`
   column to `classes` — nothing works below without it.

2. **Deploy the updated app.js**, then go through **Course Catalog → Edit
   Course** for your existing courses and set the **Year** field on each one
   (new field, sits right under Mode). Auto-enrollment matches a student to
   a course by programme + year + mode, so a course with no year set is
   invisible to it, backfill included.

3. **List.** Copy `backfill-enrollments-1-list.mjs` anywhere on your
   machine (Node 18+, no `npm install`) and run it:

   ```
   SUPABASE_URL="https://<your-project>.supabase.co" \
   SUPABASE_SERVICE_ROLE_KEY="<your service role key>" \
   node backfill-enrollments-1-list.mjs
   ```

   Read-only. Produces `students-missing-enrollments.json` and a `.csv` —
   every student with zero enrollment rows today, and how many classes each
   one would be matched to. Skim the `.csv`, especially `matchedClassCount`
   — a student showing 0 almost always means step 2 isn't done yet for
   their programme/year.

4. **Dry run, then apply.** Same folder, same env vars:

   ```
   node backfill-enrollments-2-apply.mjs            # dry run — prints only
   node backfill-enrollments-2-apply.mjs --apply    # actually enrolls them
   ```

   Safe to re-run if interrupted. Writes `backfill-enrollments-results.json`
   with a per-student outcome and a summary count.

5. **Verify.** Sign in as (or ask) the student who reported this and confirm
   their timetable now shows their courses.

## What this does not do

- Doesn't touch anything for a student who already has at least one
  enrollment row — only ever fills in genuinely missing ones.
- Doesn't create or modify any course, programme, or student account —
  purely links existing students to existing classes.
- Won't match anything until `classes.year` is actually set — this is by
  design, so a still-untagged course can never silently pull a student
  into the wrong year's material.
