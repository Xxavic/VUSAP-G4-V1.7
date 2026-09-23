-- Adds a `class_id` column to public.live_qr_sessions (the ephemeral
-- rotating QR/PIN broadcast table), so a live session broadcast can be
-- tied to the exact class (one programme + year + mode section of a
-- course) it belongs to -- not just a bare course code.
--
-- Why: the same course code can be taught as more than one class -- e.g.
-- CSC3101 taught to Year 1 Computer Science AND, separately, to Year 3
-- Computer Science. Before this column existed, every place that needed
-- to resolve "which `classes` row is this live session/scheduling
-- session/attendance sweep actually for" could only look it up by course
-- code alone (`.eq('code', courseCode).maybeSingle()`), which breaks the
-- moment two classes share a code: either the lookup errors outright
-- (more than one row matches `.maybeSingle()`), or -- worse -- it
-- silently attaches a Day-mode session's scheduling row, attendance
-- writes, or no-show sweep to the WRONG programme's class. That bug sat
-- in liveEnsureSchedulingSession(), liveResolveSessionId(), and
-- liveFinalizeSessionAttendance() in app.js; see resolveClassRow()'s
-- comment there for the full writeup and the fix this column enables.
--
-- Nullable and additive, same pattern as migrate-classes-year-column.sql:
-- every existing broadcast row, and every project that hasn't run this
-- yet, keeps working exactly as before -- app.js already falls back to
-- the old course-code-only lookup (and retries once without class_id on
-- write/read if this column doesn't exist yet) whenever class_id is
-- unknown. No RLS changes needed: live_qr_sessions' existing policies
-- already govern this column like any other.
--
-- *** DEPLOY ORDER MATTERS ***: run this BEFORE deploying the app.js that
-- expects it. app.js has a one-retry safety net for the write path
-- (liveWriteSession) and the student discovery read path
-- (liveFindActiveSession) specifically so an out-of-order deploy doesn't
-- break live check-in outright -- but class_id will simply stay unset
-- (falling back to the old, ambiguous code-only lookup) until this has
-- actually run. Run it first and there's nothing to fall back to.
--
-- Safe to run once. `add column if not exists` is idempotent.

alter table public.live_qr_sessions
  add column if not exists class_id uuid references public.classes(id);

-- Speeds up the class-scoped lookups liveFindActiveSession() and
-- subscribeToLiveSession()'s Realtime filter now do (WHERE class_id = ...
-- alongside the existing course_code/mode filters). Not required for
-- correctness -- live_qr_sessions is a small, ephemeral table -- but
-- cheap and harmless to have.
create index if not exists live_qr_sessions_class_id_idx
  on public.live_qr_sessions (class_id);
