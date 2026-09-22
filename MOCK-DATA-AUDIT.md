# Mock Data Audit — Full Sweep

**Date:** September 2026
**Requested by:** Chris, after the Class Coordinator fake-roster bug
**Scope:** every hardcoded/demo data structure in `app.js`, why it's still there, whether it can leak fictional data onto a real account, and a recommendation.

## Read this part first

1. ~~**The public login screen exposes real-looking login credentials for all four roles, including Administrator, to anyone.**~~ **RESOLVED (Sept 2026).** The "TEST ACCOUNTS" box and its `fillDemo()` helper have been removed from `app.js` entirely (commit `d357103`) — not just hidden, since the credential strings were also shipped in plaintext in the file itself, reachable without ever clicking the box. The five live account passwords (`VU-CSF-2401-0001-DAY`, `VU-CSF-2401-0002-DAY`, `VU-LEC-101`, `VU-REG-COMP-001`, `VU-ADM-001`) have also been rotated directly in Supabase, so the old values are dead even where they leaked (e.g. earlier git history). No further action needed on this item.
2. **The core problem is a repeated pattern, not one bad file.** Ten-plus data structures across the app follow the same shape: a hardcoded mock array/object ships as the default, and the "load real data" function that's supposed to replace it either (a) only overwrites entries that share a matching key and leaves every non-matching mock entry in place forever, (b) deliberately falls back to mock whenever the live result is empty ("an empty list looks broken"), (c) has no live loader at all, or (d) is a bare hardcoded number with no data source. Because mock IDs/codes/names can coincidentally collide with real live ones (this already happened twice — Afayo's course codes, and the coordinator's programme/year), this isn't just "stale demo data sitting unused," it's a live mechanism for real accounts to inherit fictional notifications, classmates, courses, and stats.

Already fixed this week (before this report): the 97% attendance-rate constant on Student Home, the stale mock course list bleeding notifications onto a newly-enrolled student, and the Class Coordinator's fake roster. Everything below is what's left.

---

## Part 1 — People / accounts

### STUDENTS (~521 fictional entries) — **RESOLVED (Sept 2026).**
- **What:** a large hardcoded seed array of fictional students with names, registration numbers, departments, years, and fabricated attendance percentages/trends.
- **Fix:** `loadStudentsFromSupabase()` now purges every mock entry that didn't get matched/replaced by a live row, once genuinely live (non-empty `rows`). `STUDENTS` no longer contains any non-`supabaseId` entry in `LIVE_BACKEND` mode, so Lecturer session rosters, Registrar-side analytics, and the Administrator People/Database screen all stopped inheriting fictional students without needing their own per-screen filter. The Class Coordinator roster's existing `supabaseId` filter is now redundant but was left in place as cheap defense-in-depth. Commit `7258baa`.

### LECTURERS / REGISTRARS / ADMINISTRATORS (staff directories) — **RESOLVED (Sept 2026).**
- **What:** three hardcoded arrays of fictional staff members.
- **Fixed (account creation):** the bigger problem here — `createStaffAccount()` not actually provisioning a live account for any of the three roles — is fixed. It now calls the same `authProvisionAccount()` / `create-user` Edge Function path `handleEnroll()` already used for students, so creating a Lecturer/Registrar/Administrator through the app's own UI now creates a real Supabase Auth login, not just a local mock entry. Commit `62dd414`.
- **Fixed (live loader):** `loadStaffFromSupabase()` now merges live `public.users` rows (role in lecturer/registrar/administrator) into the three directory arrays by `university_id`, then purges any unmatched mock seed entry per role once that role has genuinely live data — same merge-then-purge shape as `loadStudentsFromSupabase()`. So a Lecturer/Registrar/Administrator created directly in Supabase now shows up in the People directory without going through this app's Create Account form, and the mock seed staff stop sticking around once real accounts exist for that role. Wired into the same three lifecycle points as the STUDENTS loader (page load, post sign-in, resumed session) plus the `register` and `database` screens on entry.
- **Caveat:** there's no dedicated department column on `users`, so a Lecturer's `dept` now round-trips through the otherwise-unused `program` column (`createStaffAccount()` writes it, the loader reads it back) — a Lecturer provisioned directly in Supabase with `program` left null will show no department until someone sets it. A Registrar's department still derives from `faculty_key` (unchanged). Administrator never had a dept concept in the mock layer either, so that stays null.

### USERS (mock credential store) — **RESOLVED (Sept 2026).**
- **What:** hardcoded username/password pairs used to demo-login as each role without touching Supabase.
- **Scope correction:** `USERS` itself is not just a login table — it's the local overlay `suspendAccount()`/`reactivateAccount()`, `reassignRegistrar()`, consent tracking, and the Database screen's orphan-account check all read and write. Deleting the array outright (the audit's second option) would have broken all of that, not just demo login, so it stays.
- **Fix:** Chris chose the first option — the seeded demo passwords (`student2026`, `lecturer2026`, etc.) are now deleted from every `USERS` entry at load time whenever `LIVE_BACKEND` is true (i.e. the Supabase client initialised, which is true on essentially every load except a genuinely first-ever-offline one — see `authSignIn()`'s mock fallback, only reachable when `LIVE_BACKEND` is false or the live call throws). A truly offline first load is the only case that still has them, matching the audit's "keep behind a `LIVE_BACKEND === false` gate" recommendation. Doesn't remove the literal strings from the shipped `app.js` source itself — there's no build/minify step in this project to strip them from — only from what's readable at runtime in a live session (verified via console: `USERS[...]` has no `password` key once `LIVE_BACKEND` is true).

---

## Part 2 — Courses / schedule / records

### SCHEDULE — **Decision made (Sept 2026): stays mixed, no change for now.**
- **What:** hardcoded mock class schedule entries.
- **Live loader:** merge-never-purge, same pattern as STUDENTS — and this one is explicitly called out as intentional in the code's own comments.
- **Coupling found while fixing STUDENTS (Sept 2026):** `COURSES` (below) is built at boot by `buildInitialCourseCatalog()` by reading every distinct course code straight out of the mock `SCHEDULE` array — so a course that only ever exists in a mock timetable slot is exactly how it ends up in the Course Catalog at all. SCHEDULE and COURSES can't be purged independently: applying the STUDENTS-style "drop everything not confirmed live" fix to COURSES alone, while SCHEDULE keeps its intentionally-mixed mock/live timetable forever, would make legitimately-still-mock courses vanish from the Catalog while their lectures kept showing up on the Timetable — a worse inconsistency than the current leak.
- **Decision:** Chris chose to leave the timetable permanently mixed for now, rather than migrate it fully live. No code changed. If this is ever revisited, COURSES would need its own independent "confirmed live" flag (rather than a full purge) so it can stop leaking incidental-collision-only cleanup without depending on SCHEDULE also going fully live.

### LECTURER_COURSES — **RESOLVED (Sept 2026).**
- **What:** 2 fake course entries, hardcoded to "Dr. Patrick Mukasa" and shown to whichever Lecturer happened to be logged in — a real bug, not just dead-looking data.
- **Fix:** deleted outright. Its three call sites (Lecturer dashboard's "Assigned Courses" tile, the Post Announcement course `<select>`, and one comment reference) now all read from `getLecturerLectures()`, which was already correct and live-aware. Commit `2021a4d`.

### COURSES — still open (same decision as SCHEDULE above: staying mixed for now)
- **What:** mock course catalog (this is the one with the `CSC3101`/`CSC3103` codes that collided with the real "Dr. Patrick Mukasa" courses). Built at boot from mock `SCHEDULE`'s own course codes (see above) — it isn't an independent mock array.
- **Live loader:** only purges a mock entry when its code exactly collides with a live course's code — otherwise every non-colliding mock course stays forever.
- **Recommendation:** same fix shape as STUDENTS in isolation, but see the SCHEDULE note above — purging COURSES without a matching decision on SCHEDULE risks making things worse, not better. Needs the same decision made for both together.

### RECORDS (bulk attendance history) — **RESOLVED (Sept 2026).**
- **What:** no live loader existed at all for bulk historical attendance records.
- **Correction to this entry's own earlier note:** `venue` turned out NOT to need a schema change. `classes` has no `room` column by design (as noted below), but `SCHEDULE` already carries the right room per (course code, weekday) once the timetable is live — the same source `liveLoadAttendanceForLectureDate()` already used for its single-lecture sync. No migration needed.
- **Fix:** `loadRecordsFromSupabase()` pulls `attendance` joined through `sessions -> classes -> programmes` (the 3-level join this entry originally flagged), batch-resolves each student's reg number via a `users` lookup, and derives `venue` from a `SCHEDULE`-built lookup. Merges into RECORDS by `(code, date, reg)` — live wins on a match, nothing is purged on a miss (matches the SCHEDULE/COURSES "stays mixed" decision). Wired into `navigate()` for the screens that actually read RECORDS in bulk: records, facultyRecordsCatalog, courseRecords, myAttendance, database. Soft-capped at the 1000 most recent rows, same reasoning as the 200-row caps elsewhere in this file — not a guaranteed complete history, just enough that real records aren't invisible. Commit `503da13`.

### RECENT_SUBMISSIONS — **RESOLVED (Sept 2026).**
- **What:** hardcoded list (5 fictional rows), purely additive — nothing ever removed entries from it, live data could only be added on top.
- **Fix:** now that RECORDS itself is live (see above), the array is gone entirely — `scopedRecentSubmissions()` derives it on every render as the newest 5 rows of `scopedRecords()`, sorted explicitly by date (RECORDS isn't guaranteed array-order-sorted — see `loadRecordsFromSupabase()`'s own comment on why). `submitAttendance()`'s duplicate push into a separate `RECENT_SUBMISSIONS` array is removed; it already wrote the same row into `RECORDS`, which is now the only source. This also fixes a bug the original entry didn't call out: a live correction made on another device, or any row `loadRecordsFromSupabase()` loaded, never used to reach `RECENT_SUBMISSIONS` at all — now it does, automatically, since there's nothing separate to keep in sync.

### ATTENDANCE_APPEALS / SUPPORT_TICKETS — **RESOLVED (Sept 2026).**
- **What:** mock appeal/ticket entries.
- **Fix:** the `localOnly` re-inclusion filter used to key off "no `supabaseId` yet," which was meant to protect a just-submitted appeal/ticket from disappearing during the live-insert race, but couldn't tell that apart from a permanent mock seed entry (which also never has a `supabaseId`). Replaced with an explicit `pendingSync` flag, set true only at the moment of submission and cleared once the live insert resolves — a mock seed entry never has it set, so it's no longer resurrected on every load. Commit `7258baa`.

---

## Part 3 — Analytics / logs / notifications / structural data

### PROGRAMME_ANALYTICS / FACULTY_ANALYTICS / FACULTY_COUNTS — **RESOLVED (Sept 2026).**
- **What:** aggregate stats objects.
- **Fix:** `recomputeFacultyProgrammeDerivedData()` is now also called at the end of `loadFacultiesAndProgrammesFromSupabase()` and `loadStudentsFromSupabase()` (previously it only ran from the Administrator's own Faculty/Programme CRUD actions). Whichever of the two live loads resolves last ends up authoritative, matching the same eventual-consistency tolerance this file already relies on everywhere else. Commit `3e224f5`.

### LECTURER_COMPLIANCE
~~- **What:** a hardcoded compliance dataset.~~ **RESOLVED (Sept 2026).** Now computed from real live data: sessions held comes from the live `sessions` table (grouped by teacher_id), sessions expected comes from confirmed-live SCHEDULE slots × weeks elapsed since a new Administrator-set `termStartDate` (System Settings screen, migration `migrate-term-start-date.sql` — Chris still needs to run this and set a date for the report to show real numbers instead of "Term Start Date isn't set yet"). A lecturer with no live-confirmed weekly slots shows "—"/N/A rather than a fabricated rate, in both the on-screen report and its CSV/PDF export. Commit `eb4a6e3`.

### DEPT_COUNTS — **RESOLVED (Sept 2026).**
- **What:** confirmed entirely dead code — not referenced anywhere live.
- **Fix:** deleted outright. Commit `2021a4d`.

### FACULTIES / PROGRAMMES — **RESOLVED (Sept 2026).**
- **What:** the one structure in the whole audit whose live loader is done correctly — full replace on load, no leftover mock entries.
- **Fix:** the one remaining gap here (loading it didn't trigger a recompute of what depends on it) is the same fix already described under PROGRAMME_ANALYTICS / FACULTY_ANALYTICS / FACULTY_COUNTS above — `recomputeFacultyProgrammeDerivedData()` now runs after this loads too. Commit `3e224f5`.

### SUSPICION_LOG / AUDIT_LOG / NOTIFICATIONS (seed data)
~~- **What:** three separate structures, all sharing the identical "empty looks broken" bug — the loader deliberately keeps the mock seed rows whenever the live result comes back empty, on the same flawed reasoning that caused the notifications-before-account-existed bug you already found.~~ **ALL THREE RESOLVED (Sept 2026).**
- **AUDIT_LOG:** now clears to an honest empty log on a genuinely-empty live result instead of keeping the 5 fictional rows, and visiting Backups or Database Management now also refreshes it first — so `exportSnapshot()`'s real JSON backup can no longer ship fabricated audit history. Commit `b8b6b63`.
- **NOTIFICATIONS:** now clears to an honest empty inbox on a genuinely-empty live result, so the mock `recipientRole:'all'` seed row (which broadcast to literally every real user of every role) can no longer survive past the first real login. Commit `9190ce1`.
- **SUSPICION_LOG:** same fix — clears to an empty fraud-flag list instead of leaving 3 named students (David Kiggundu, Fred Kibirige, Opio Emmanuel) permanently flagged for cheating in every fresh install. Visiting Database Management now also refreshes it first, matching the AUDIT_LOG fix, so its live count on that screen stays accurate. Commit `9190ce1`.

### ANNOUNCEMENTS — **RESOLVED (Sept 2026).**
- **What:** hardcoded announcements.
- **Fix:** live read/write wiring added, matching the loadSupportTicketsFromSupabase()/loadAppealsFromSupabase() shape. submitAnnouncement() now writes to a new `announcements` table via liveWriteAnnouncement() (fire-and-forget, with a pendingSync flag so a just-submitted post isn't mistaken for a permanent mock seed), and loadAnnouncementsFromSupabase() loads live rows on entering announcements/home/dashboard, merging in any still-pending local post and dropping mock seeds once live data exists. Requires the `announcements` table + RLS from `migrate-announcements.sql` (delivered separately, not yet run) — INSERT is restricted to Lecturer/Registrar, matching the UI's own `canPost` rule; Administrator cannot post in the UI today and this migration doesn't change that. Commit `e6982d7`.

### Lecturer dashboard "87%" — **RESOLVED (Sept 2026).**
- **What:** a single bare hardcoded percentage on the Lecturer dashboard's Attendance Rate tile, with no computation and no data source at all — confirmed via a full-file grep to be the only literal of its kind left anywhere in the app.
- **Fix:** now computed from the lecturer's own RECORDS via weightedAttendancePct(), scoped to the course codes returned by getLecturerLectures() — same present-or-late-over-total pattern already used correctly on the Registrar dashboard. Commit `2021a4d`.

---

## Overall picture

Every item above falls into one of four buckets:

1. **Same bug, already has a proven fix** (the "empty looks broken" pattern — STUDENT_COURSES already fixed this week; SUSPICION_LOG, AUDIT_LOG, and the NOTIFICATIONS seed still need it).
2. **Merge-never-purge** (STUDENTS — resolved; ATTENDANCE_APPEALS/SUPPORT_TICKETS — resolved; SCHEDULE and COURSES — Chris decided to leave these mixed for now, see their entries above) — needs the array to actually drop non-matching mock rows once live, not just overwrite matches.
3. **No live loader existed at all** (LECTURERS/REGISTRARS/ADMINISTRATORS, RECORDS, ANNOUNCEMENTS, LECTURER_COMPLIANCE — all now resolved) — these were missing features, not stale data; deleting the mock wouldn't have fixed anything without building the real thing first.
4. **Dead or trivially fixable** (DEPT_COUNTS — delete; LECTURER_COURSES — repoint to existing correct function; the 87% tile — compute like Student Home already does).

Plus the two standalone flags: the login-screen credential exposure (fix now, independent of everything else) and the two real documents (LECTURER_COMPLIANCE export, AUDIT_LOG backup export) that currently ship fabricated data to real stakeholders — these two probably deserve priority over the UI-only items, since they leave the app as real-looking paperwork.

**On "removing it all completely":** that's realistic for buckets 1, 2, and 4 — the mock data itself can go once each loader is fixed to fully replace it. It is not realistic for bucket 3 without building the missing live features first, since removing that mock data today would just leave those screens and that PDF/CSV export empty or broken, with nothing behind them yet.

## Suggested order, if you want one

1. Login-screen credential exposure — independent, urgent, quick to fix.
2. LECTURER_COMPLIANCE and AUDIT_LOG backup export — fake data currently leaving the app as real documents.
3. The three "empty looks broken" repeats (SUSPICION_LOG, AUDIT_LOG display, NOTIFICATIONS seed) — same fix already proven this week.
4. Merge-never-purge structures (STUDENTS everywhere, SCHEDULE, COURSES, tickets/appeals) — the biggest chunk of work, but same fix pattern each time.
5. Dead/trivial cleanup (DEPT_COUNTS, LECTURER_COURSES, the 87% tile).
6. ~~Missing-feature items (staff account provisioning, RECORDS bulk loader, ANNOUNCEMENTS live wiring).~~ **All done (Sept 2026)** — staff provisioning + directory loader, RECORDS bulk loader, and ANNOUNCEMENTS live wiring are all resolved above.

Let me know which of these you want tackled first and I'll start there.
