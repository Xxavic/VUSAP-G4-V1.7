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

### LECTURERS / REGISTRARS / ADMINISTRATORS (staff directories) — **partially resolved (Sept 2026).**
- **What:** three hardcoded arrays of fictional staff members.
- **Fixed:** the bigger problem here — `createStaffAccount()` not actually provisioning a live account for any of the three roles — is fixed. It now calls the same `authProvisionAccount()` / `create-user` Edge Function path `handleEnroll()` already used for students, so creating a Lecturer/Registrar/Administrator through the app's own UI now creates a real Supabase Auth login, not just a local mock entry. Commit `62dd414`.
- **Still open:** the three directory arrays (`LECTURERS`/`REGISTRARS`/`ADMINISTRATORS`) still have no live loader — they only grow (via the fix above, and via the original mock seed), never load or purge against `public.users`. So a Lecturer/Registrar/Administrator created directly in Supabase (not through this app's Create Account form) still won't show up in these directories, and the mock seed staff never disappear. Lower priority than the fix above since account creation itself now works correctly.

### USERS (mock credential store)
- **What:** hardcoded username/password pairs used to demo-login as each role without touching Supabase.
- **Risk:** low now that the login-screen exposure is fixed — these strings no longer match any live account's real password (rotated Sept 2026), so even if someone found them they'd only ever reach the offline/mock UI with fictional data, never a real account. Still sitting in plaintext in `app.js`, which is its own minor smell.
- **Recommendation:** no urgency now, but still worth deciding: keep this array behind a `LIVE_BACKEND === false` (dev-only) gate, or delete it outright once you're confident you won't need offline/demo mode anymore.

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

### RECORDS (bulk attendance history) — investigated (Sept 2026), still open
- **What:** no live loader exists at all for bulk historical attendance records.
- **Why it's bigger than it looks:** a RECORDS-shaped row (`{date, reg, name, prog, code, course, venue, status}`) needs a 3-level join to reconstruct live — `attendance -> sessions(date) -> classes(code, name, programme_id -> programmes.name)`, plus `attendance.student_id -> users.university_id` for `reg`. Worse, `venue` has no live source at all under the current schema (an existing code comment near `loadClassesFromSupabase()` confirms `classes` has no `room` column by design — "room is a timetable_slots-level concept"). RECORDS also already receives ongoing local-only writes today (via `RECORDS.unshift()`/`RECORDS[idx]=...` at several call sites, triggered by real check-ins/corrections/overrides), keyed by `(code, date, reg)` with no `supabaseId` tracking at all — a live loader would need to merge against that existing convention, not introduce a fresh one on top of it.
- **Recommendation:** this is a genuine missing feature, not stale mock data to delete, and a bigger one than the one-liner above suggested. Needs its own scoped piece of work — probably starting with a decision on where `venue` should live (a new column, or accept it stays manual/mock) — rather than being folded into a quick cleanup pass.

### RECENT_SUBMISSIONS — investigated (Sept 2026), still open
- **What:** hardcoded list (5 fictional rows), purely additive — nothing ever removes entries from it, live data can only be added on top.
- **Why it's tied to RECORDS above:** it's populated from the exact same correction/check-in call site that pushes into `RECORDS`, and conceptually it's just a "most recent slice" of the same attendance history — not an independently-fixable array. It has the same root blocker as RECORDS (no live query currently reconstructs this shape), so a real fix here should happen alongside RECORDS, not before it — patching this in isolation (e.g. copying the NOTIFICATIONS/SUSPICION_LOG "clear on genuinely-empty live result" fix) wouldn't have anywhere to load live rows FROM yet.
- **Recommendation:** address together with RECORDS once that's scoped, not separately.

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
3. **No live loader exists at all** (LECTURERS/REGISTRARS/ADMINISTRATORS, RECORDS, ANNOUNCEMENTS, LECTURER_COMPLIANCE) — these are missing features, not stale data; deleting the mock wouldn't fix anything without building the real thing first.
4. **Dead or trivially fixable** (DEPT_COUNTS — delete; LECTURER_COURSES — repoint to existing correct function; the 87% tile — compute like Student Home already does).

Plus the two standalone flags: the login-screen credential exposure (fix now, independent of everything else) and the two real documents (LECTURER_COMPLIANCE export, AUDIT_LOG backup export) that currently ship fabricated data to real stakeholders — these two probably deserve priority over the UI-only items, since they leave the app as real-looking paperwork.

**On "removing it all completely":** that's realistic for buckets 1, 2, and 4 — the mock data itself can go once each loader is fixed to fully replace it. It is not realistic for bucket 3 without building the missing live features first, since removing that mock data today would just leave those screens and that PDF/CSV export empty or broken, with nothing behind them yet.

## Suggested order, if you want one

1. Login-screen credential exposure — independent, urgent, quick to fix.
2. LECTURER_COMPLIANCE and AUDIT_LOG backup export — fake data currently leaving the app as real documents.
3. The three "empty looks broken" repeats (SUSPICION_LOG, AUDIT_LOG display, NOTIFICATIONS seed) — same fix already proven this week.
4. Merge-never-purge structures (STUDENTS everywhere, SCHEDULE, COURSES, tickets/appeals) — the biggest chunk of work, but same fix pattern each time.
5. Dead/trivial cleanup (DEPT_COUNTS, LECTURER_COURSES, the 87% tile).
6. Missing-feature items (staff account provisioning, RECORDS bulk loader, ANNOUNCEMENTS live wiring) — treat as new feature work, on your own timeline, not as part of "removing mock data."

Let me know which of these you want tackled first and I'll start there.
