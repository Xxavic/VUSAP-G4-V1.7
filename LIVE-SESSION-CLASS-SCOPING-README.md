# Fixing "which class does this live session belong to"

This is the bug flagged alongside the My Students rebuild: three live
functions resolved a `classes` row by course code alone, which breaks the
moment the same code is taught to more than one programme/year (a
confirmed real scenario). This closes that gap for live sessions,
scheduling rows, and attendance writes -- the QR/PIN check-in path itself,
not just a display screen, so treat this one as higher-stakes than most
changes here.

## What was actually broken

`liveEnsureSchedulingSession()`, `liveResolveSessionId()`, and
`liveFinalizeSessionAttendance()` all did
`.from('classes').eq('code', courseCode).maybeSingle()`. With two
`classes` rows sharing a code, `.maybeSingle()` either errors (more than
one row matched) or -- if you got lucky and only one ever existed when
you tested -- silently attaches the wrong programme's roster the day a
second one is added. This sits underneath every scheduling `sessions` row
and every `attendance` write a live QR/PIN check-in makes.

## What changed

- New `resolveClassRow(courseCode, classId)` helper: resolves the exact
  `classes` row by id when a `classId` is known, falling back to the old
  code-only lookup (now `.limit(1)` instead of `.maybeSingle()`, so it
  never throws) only when it isn't.
- `classId` is now threaded end-to-end: the Lecturer's picked lecture
  (`loadTimetableFromSupabase()`, `getLecturerLectures()`) carries it,
  `LIVE_SESSION.classId` carries it once a session starts
  (`startSessionForLecture()`), the broadcast row itself now carries it
  (`live_qr_sessions.class_id`, written by `liveWriteSession()`), and
  everything downstream -- scheduling session resolution, attendance
  writes, the no-show sweep, Attendance Corrections' live sync, a
  Student's own session discovery -- reads it back off whichever of those
  it's closest to, instead of re-deriving it from a bare course code.
- Student-side and Lecturer-side session discovery
  (`liveFindActiveSession()`) also takes an optional `classId`, so two
  different programmes broadcasting the same code+mode at the same time
  (rarer, but possible) resolve independently instead of colliding.

## Order matters

1. **Run `migrate-live-sessions-class-id.sql`** (Supabase SQL Editor, same
   as the other `migrate-*.sql` files in this repo). Adds a nullable
   `class_id` column to `live_qr_sessions` plus an index. Nothing else
   works correctly without it.
2. **Deploy the updated `app.js`.**

If you deploy app.js before running the migration: it won't break live
check-in outright -- `liveWriteSession()` and `liveFindActiveSession()`
both detect a "column does not exist" error and retry once without
`class_id`, so sessions keep working exactly as before this fix in that
window. But `class_id` stays unset the whole time, meaning the original
ambiguous-course-code bug is still live until the migration actually
runs. Don't rely on the safety net -- it's there so an accidental
out-of-order deploy degrades instead of breaking, not as a substitute for
running the migration first.

## What this does not do

- Doesn't touch `sessions` or `attendance` — those already keyed
  correctly off `class_id`/`session_id`; only the broadcast layer
  (`live_qr_sessions`) and its resolution logic needed this.
- Doesn't retroactively fix any attendance already recorded against the
  wrong class before this deploys — this is a forward-looking fix, not a
  data correction. If you suspect a specific past session was
  misattributed, that would need to be checked and corrected by hand.
- `liveDeactivateOtherSessions()` (cleans up a lecturer's own stale
  sessions on a new start) was deliberately left as-is — it doesn't
  resolve a `classes` row at all, so it was never part of this bug, and
  its "only one live session per lecturer per mode" behavior looked
  intentional rather than something to change here.

## Verify

- As a Lecturer who teaches the same course code to two different
  programmes/years: start a live session for one, confirm the roster/
  attendance only ever shows that section's students, then do the same
  for the other section and confirm it's independently correct.
- Reload mid-session (both roles) and confirm the session is rediscovered
  correctly rather than losing track of which class it's for.
- Check a live_qr_sessions row after starting a session and confirm
  `class_id` is actually populated (only possible after the migration has
  run).
