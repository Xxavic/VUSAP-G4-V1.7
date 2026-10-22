# QRAST — Fresh-Client Test Plan (empty database)

Purpose: prove what a brand-new institution sees on day one, before we onboard a real client. Report what actually happened, step by step.

## What should happen

`client-config.js` has `demoData: false` for every new client. At boot, `clearDemoSeedData()` empties every mock seed (faculties, programmes, students, staff, courses, timetable, records, announcements, appeals, tickets, logs, notifications, demo logins), so the loaders' keep-mock fallbacks have nothing to show. Expected on an empty database:

| Area | Expected with `demoData: false` |
|---|---|
| Faculties / programmes | Empty; the faculties loader accepts an empty result as real |
| Students, staff | Empty |
| Course Catalog | Empty |
| Timetable, "today's lectures" | Empty |
| Enroll form | Explains that a programme is needed (no crash on `PROGRAMMES[0]`) |
| Registration counter | First enrolled student gets `…-0001-…` |
| Crest (no logo uploaded) | Neutral purple placeholder crest, not the Victoria shield |
| Institution / portal name | "Your Institution" / "QR-code Realtime Attendance Scanning Technology" (from the `system_settings` seed) |

So far this has only been checked by a headless render of every screen. This test is the first run against a real empty project.

## Setup

1. Create a throwaway Supabase project (free tier is fine). Do not use Victoria's.
2. On Victoria's project, export the base schema to `schema-dump.sql` (`SCHEMA-EXPORT-README.md`, Option A). You run this; it needs the DB password.
3. Run `node build-sql-bundle.mjs` and paste `dist/qrast-setup.sql` into the throwaway project's SQL Editor. Note any statement that errors on an empty database.
4. Deploy the five Edge Functions with their secrets (`SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `NOTIFY_FROM_EMAIL`, `AUTH_EMAIL_DOMAIN`).
5. Create one Administrator account in Auth and in `users`.
6. Copy the app folder. In `client-config.js` put the throwaway project's URL and anon key and set `demoData: false`. Serve it locally or on a scratch host.

## Checks (as the new Administrator, on a phone-width screen)

1. **Login works.** Report any console error.
2. **Dashboard / analytics.** All numbers zero or blank, no names or charts with data.
3. **People / Register.** No students, lecturers or registrars listed.
4. **Faculties and programmes.** Nothing in dropdowns, Register, or Course Catalog.
5. **Course Catalog.** No courses.
6. **Timetable / Schedules.** No slots, no "today's lectures".
7. **Notifications, announcements, audit log, appeals, support tickets.** No seed rows.
8. **Branding.** Login screen, boot splash and header show the neutral crest and "Your Institution". Nothing says "Victoria University" or shows the Victoria shield. Then upload a crest and set the name in System Settings; confirm both change everywhere and survive a reload.
9. **Enroll form before any programme exists.** It explains that a programme is needed instead of crashing.
10. **Create from scratch:** add a faculty, a programme, a course, then enroll one student. Any error? Generated ID looks like `VU-<programme>-2601-0001-DAY` (prefix comes from `idPrefix`).
11. **Reload** after each step 10 creation. Data persists, no mock data returns.
12. **Console check:** there should be no `console.warn` containing "keeping mock". Collect any that appear.

## Report back

A table: screen, what appeared, expected (empty) or leaked (mock/Victoria). Include screenshots of any leak and any SQL statement that errored. Delete the throwaway project afterwards if it will not be reused.
