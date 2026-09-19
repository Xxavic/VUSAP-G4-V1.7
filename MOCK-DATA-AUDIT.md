# Mock Data Audit — Full Sweep

**Date:** September 2026
**Requested by:** Chris, after the Class Coordinator fake-roster bug
**Scope:** every hardcoded/demo data structure in `app.js`, why it's still there, whether it can leak fictional data onto a real account, and a recommendation.

## Read this part first

Two items need attention regardless of what you decide about the rest:

1. **The public login screen exposes real-looking login credentials for all four roles, including Administrator, to anyone.** A "TEST ACCOUNTS" box on the live, unauthenticated login screen lets any visitor auto-fill and sign in with Student/Lecturer/Registrar/Administrator demo credentials with one click. Nothing gates it — no environment check, no build flag. This is live right now on the public site. This is the single most urgent finding in this audit and is unrelated to the broader mock-data cleanup question — it should be pulled regardless of what happens with the rest.
2. **The core problem is a repeated pattern, not one bad file.** Ten-plus data structures across the app follow the same shape: a hardcoded mock array/object ships as the default, and the "load real data" function that's supposed to replace it either (a) only overwrites entries that share a matching key and leaves every non-matching mock entry in place forever, (b) deliberately falls back to mock whenever the live result is empty ("an empty list looks broken"), (c) has no live loader at all, or (d) is a bare hardcoded number with no data source. Because mock IDs/codes/names can coincidentally collide with real live ones (this already happened twice — Afayo's course codes, and the coordinator's programme/year), this isn't just "stale demo data sitting unused," it's a live mechanism for real accounts to inherit fictional notifications, classmates, courses, and stats.

Already fixed this week (before this report): the 97% attendance-rate constant on Student Home, the stale mock course list bleeding notifications onto a newly-enrolled student, and the Class Coordinator's fake roster. Everything below is what's left.

---

## Part 1 — People / accounts

### STUDENTS (~521 fictional entries)
- **What:** a large hardcoded seed array of fictional students with names, registration numbers, departments, years, and fabricated attendance percentages/trends.
- **Live loader:** `loadStudentsFromSupabase()` exists and now tags live rows with `supabaseId` (added this week). But it only **replaces** a mock entry when a live row's registration number matches one — every mock entry that doesn't match a real student stays in the array forever. Nothing ever removes them.
- **Where it leaks:** any screen that reads the global `STUDENTS` array without filtering by `supabaseId` still mixes in fictional students — this includes Lecturer session rosters, Registrar-side analytics, and the Administrator "Database" screen, which currently claims to show "live" data while actually showing ~521 fake students plus however many real ones exist. (The Class Coordinator roster was patched this week to filter on `supabaseId`; the other three surfaces were not.)
- **Recommendation:** apply the same `LIVE_BACKEND ? filter(s => s.supabaseId) : STUDENTS` pattern everywhere `STUDENTS` is read for a real user-facing list, or better, purge non-matching mock entries once `loadStudentsFromSupabase()` runs with `LIVE_BACKEND` on, the same way the `STUDENT_COURSES` fix works now. The scoped per-screen fix is a stopgap; the merge function itself needs to stop being merge-never-purge.

### LECTURERS / REGISTRARS / ADMINISTRATORS (staff directories)
- **What:** three hardcoded arrays of fictional staff members.
- **Live loader:** none exist. There is no live-loading function for any of these three roles at all.
- **Bigger problem found along the way:** `createStaffAccount()` — the function meant to provision a new Lecturer/Registrar/Administrator account — does not actually create a live account for any of these three roles. It only ever writes to the local mock arrays. This means, right now, creating staff accounts through the app's own UI does not work against the live backend at all.
- **Recommendation:** this isn't really a "clean up mock data" item, it's a missing feature. Building live loaders for these three arrays and fixing `createStaffAccount()` to actually provision live accounts is its own piece of work, separate from the cleanup you asked about.

### USERS (mock credential store)
- **What:** hardcoded username/password pairs used to demo-login as each role without touching Supabase.
- **Risk:** harmless by itself (it's just a local JS object), but it's the data source for the "TEST ACCOUNTS" box flagged at the top of this report — that's the actual exposure, not this array.
- **Recommendation:** once the login-screen exposure (item 1 above) is fixed, decide whether to keep this array at all behind a `LIVE_BACKEND === false` (dev-only) gate, or delete it outright once you're confident you won't need offline/demo mode anymore.

---

## Part 2 — Courses / schedule / records

### SCHEDULE
- **What:** hardcoded mock class schedule entries.
- **Live loader:** merge-never-purge, same pattern as STUDENTS — and this one is explicitly called out as intentional in the code's own comments.
- **Recommendation:** worth revisiting now that the "intentional" reasoning has caused two real bugs elsewhere; the assumption that merge-never-purge is safe should not be trusted anywhere else in the file either.

### LECTURER_COURSES
- **What:** 2 fake course entries.
- **Live loader:** none — it's fully static, and it's used in a place that already has a correct, live-aware alternative (`getLecturerLectures()`) sitting right next to it, unused for this purpose.
- **Recommendation:** straightforward — point the caller at `getLecturerLectures()` instead, and delete `LECTURER_COURSES`.

### COURSES
- **What:** mock course catalog (this is the one with the `CSC3101`/`CSC3103` codes that collided with the real "Dr. Patrick Mukasa" courses).
- **Live loader:** only purges a mock entry when its code exactly collides with a live course's code — otherwise every non-colliding mock course stays forever.
- **Recommendation:** same fix shape as STUDENTS — once genuinely live, purge everything not confirmed live rather than relying on incidental code collisions to clean up individual entries.

### RECORDS (bulk attendance history)
- **What:** no live loader exists at all for bulk historical attendance records.
- **Recommendation:** this is a genuine missing feature, not stale mock data to delete. Needs to be built if bulk historical records are supposed to reflect real data anywhere in the app.

### RECENT_SUBMISSIONS
- **What:** hardcoded list, purely additive — nothing ever removes entries from it, live data can only be added on top.
- **Recommendation:** same shape as the others; needs either a real replace-on-load or a purge condition, not addition-only.

### ATTENDANCE_APPEALS / SUPPORT_TICKETS
- **What:** mock appeal/ticket entries.
- **Live loader:** looks like a full replace on the surface, but has a `localOnly` filter that always re-includes every non-matching mock seed entry regardless — so it behaves like merge-never-purge under a different name.
- **Recommendation:** remove the `localOnly` carve-out once live, or scope it explicitly to `LIVE_BACKEND === false`.

---

## Part 3 — Analytics / logs / notifications / structural data

### PROGRAMME_ANALYTICS / FACULTY_ANALYTICS / FACULTY_COUNTS
- **What:** aggregate stats objects.
- **Problem:** these only get recomputed when an Administrator performs a CRUD action in the admin UI — never on app boot or when live data loads. So they go stale/mismatched the moment any data changes outside that one specific admin flow, and stay wrong indefinitely.
- **Recommendation:** needs to be recomputed whenever the underlying live data it depends on loads, not just on a narrow set of admin actions.

### LECTURER_COMPLIANCE
- **What:** a hardcoded compliance dataset.
- **Problem:** this one has no mock/live branch at all — it's embedded directly into a real PDF/CSV export that presumably goes to real stakeholders. Anyone exporting this report today is handing out fabricated compliance numbers as if they were real.
- **Recommendation:** highest priority in this section — it's not a UI display quirk, it's fake data in a document that leaves the app.

### DEPT_COUNTS
- **What:** confirmed entirely dead code — not referenced anywhere live.
- **Recommendation:** delete outright, no live loader needed.

### FACULTIES / PROGRAMMES
- **What:** the one structure in the whole audit whose live loader is done correctly — full replace on load, no leftover mock entries.
- **Remaining gap:** loading it doesn't trigger a recompute of the things that depend on it (like the analytics objects above), so downstream numbers can still be wrong even though this data itself is fine.
- **Recommendation:** use this as the reference pattern for fixing the others; just needs to also fire the dependents' recompute.

### SUSPICION_LOG / AUDIT_LOG / NOTIFICATIONS (seed data)
- **What:** three separate structures, all sharing the identical "empty looks broken" bug — the loader deliberately keeps the mock seed rows whenever the live result comes back empty, on the same flawed reasoning that caused the notifications-before-account-existed bug you already found.
- **Extra risk on AUDIT_LOG:** its mock rows also ship inside a real "backup" export — same category of problem as LECTURER_COMPLIANCE, fake data leaving the app in a real document.
- **Extra risk on NOTIFICATIONS:** the mock seed includes an entry with `recipientRole: 'all'`, meaning that one fake notification broadcasts to literally every real user of every role, not just a coincidentally-matching one.
- **Recommendation:** fix identically to the `STUDENT_COURSES` fix already shipped this week — purge on genuinely-empty live result instead of falling back to mock. This is the same bug in three places; one fix pattern covers all three.

### ANNOUNCEMENTS
- **What:** hardcoded announcements.
- **Problem:** no live wiring in either direction — nothing loads live announcements in, and nothing about the mock ones is scoped to demo mode. It's non-functional as a real feature right now.
- **Recommendation:** either build real live wiring for announcements, or clearly mark this as demo-only until it is.

### Lecturer dashboard "87%"
- **What:** a single bare hardcoded percentage on the Lecturer dashboard's Attendance Rate tile, with no computation and no data source at all — confirmed via a full-file grep to be the only literal of its kind left anywhere in the app.
- **Recommendation:** same fix as the Student Home 97% tile from this week — compute it from the lecturer's real attendance data using the same present-or-late-over-total pattern already used correctly on the Registrar dashboard.

---

## Overall picture

Every item above falls into one of four buckets:

1. **Same bug, already has a proven fix** (the "empty looks broken" pattern — STUDENT_COURSES already fixed this week; SUSPICION_LOG, AUDIT_LOG, and the NOTIFICATIONS seed still need it).
2. **Merge-never-purge** (STUDENTS, SCHEDULE, COURSES, ATTENDANCE_APPEALS/SUPPORT_TICKETS) — needs the array to actually drop non-matching mock rows once live, not just overwrite matches.
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
