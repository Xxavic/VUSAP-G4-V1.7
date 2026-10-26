# VUSAP — Offline Sync Implementation Brief
**Hand this entire document to Claude Code. Execute autonomously. Fix any bugs found along the way. Report only when done or genuinely blocked on a decision.**

---

## Project identity

- **App**: VUSAP — Victoria University Smart Attendance Platform
- **Type**: Single-file PWA (HTML/CSS/JS, no framework)
- **Live URL**: `https://xxavic.github.io/VUSAP-G4-V1.7/`
- **Supabase URL**: `https://eumhlccvaembpqxcuaqf.supabase.co`
- **Anon key**: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV1bWhsY2N2YWVtYnBxeGN1YXFmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5NTA5ODEsImV4cCI6MjA5NDUyNjk4MX0.spQS7jBkRWLjOZamVAaEPDXkqQHCzWIaqBbldd_-B0E`

## Source files

The working copy lives in `/home/claude/vu-attendance/` (or wherever the project was last built — run `ls` to confirm before touching anything).

- `index.html` — CSS + single `<div id="app">` shell + inline `<script>` (app.js was inlined here in a previous pass to make it a standalone preview file)
- `sw.js` — service worker (currently cache version `vusap-v4`)

> **Important**: The app is delivered as TWO artifacts every session:
> 1. `/mnt/user-data/outputs/vu-attendance-preview.html` — fully self-contained single file (app.js inlined) for in-chat preview
> 2. `/mnt/user-data/outputs/vu-attendance-pwa.zip` — multi-file deployment package for GitHub Pages

Both must be produced at the end of this task.

---

## Context — what this app currently is

Five roles: **Student**, **Class Coordinator** (student + extra), **Lecturer**, **Registrar**, **Administrator**.

The Lecturer starts an attendance session → generates a rotating QR code + 6-digit PIN → Students scan/type to check in → records written to Supabase `attendance_records` table.

Key module-level variables in app.js you must understand before editing:

```
LIVE_BACKEND        — boolean; true when Supabase client initialised and reachable
SUPABASE_CLIENT     — the Supabase JS client object (null when offline or CDN unavailable)
LIVE_SESSION        — object: { active, courseCode, courseName, liveSessionId, localSessionId,
                       startedAt, mode, syncInterval }
                       liveSessionId = Supabase UUID once session is live; null when offline
                       localSessionId = IndexedDB auto-increment key when session started offline
pendingRecordCount  — (ADD THIS) module-level counter of unsynced records
offlineDB           — (ADD THIS) IndexedDB handle; null until initOfflineDB() resolves

Key functions (read these fully before touching them):
  startSession()             — Lecturer confirms session; currently writes to Supabase
  endSession()               — closes session in Supabase
  resolveCheckInOutcome()    — called after QR/PIN validation; writes attendance_record
  isLiveSessionActive()      — returns true when a real session is running
  checkFraudSignals()        — MUST NOT BE MODIFIED — existing fraud detection, leave intact
  resumeSupabaseSession()    — called at DOMContentLoaded; must stay first in boot sequence
```

---

## What to build — Offline Sync

**Scope**: Only the Lecturer's session flow needs to work fully offline. Everything else (dashboards, analytics, profile, reports) should show a graceful "no connection" state — no offline queueing needed for those.

**Three failure scenarios to handle**:
- **(A)** Lecturer starts session online, device drops mid-session → records queue offline
- **(B)** Lecturer starts session with no connection at all → session + records both queue offline
- **(C)** Two devices claim the same student in the same session → conflict → fraud log

---

## Step 1 — IndexedDB layer

Add `async function initOfflineDB()` that opens database `vusap-offline` at version 1.

**Store: `pending_sessions`** — keyPath `local_id` (autoIncrement), index on `sync_status`
```js
{ local_id, course_code, course_name, lecturer_id, started_at, mode,
  sync_status,           // 'pending' | 'synced' | 'failed'
  supabase_session_id }  // null until synced
```

**Store: `pending_records`** — keyPath `local_id` (autoIncrement), indexes on `sync_status` and `local_session_id`
```js
{ local_id, local_session_id, supabase_session_id,
  student_id, student_name, course_code, status,
  checked_in_at, device_id,
  sync_status }   // 'pending' | 'synced' | 'failed' | 'conflict'
```

**Store: `sync_log`** — keyPath `id` (autoIncrement)
```js
{ id, event, detail, timestamp }
// event values: 'session_synced' | 'record_synced' | 'conflict' | 'sync_failed'
```

Call `initOfflineDB()` inside `DOMContentLoaded`, **after** `resumeSupabaseSession()`. Store the resolved handle in `let offlineDB = null` at module scope.

---

## Step 2 — Offline-aware session start

In `startSession()`, wrap the Supabase write in try/catch.

**If `LIVE_BACKEND` is false OR the write throws a network error**:
1. Write to `pending_sessions` with `sync_status: 'pending'`
2. Store the returned `local_id` in `LIVE_SESSION.localSessionId`
3. Set `LIVE_SESSION.liveSessionId = null`
4. Continue into the session UI exactly as if it worked — Lecturer sees no difference
5. Show the offline banner (Step 5)

**If online and write succeeds**: unchanged from today — `LIVE_SESSION.liveSessionId` gets the UUID, `LIVE_SESSION.localSessionId` stays null.

---

## Step 3 — Offline-aware record writes

In `resolveCheckInOutcome()`, find the Supabase insert for `attendance_records` and wrap **only that insert** in try/catch. Do not wrap the fraud checks above it.

**On network failure** (error message matches `/failed to fetch|networkerror|timeout/i`):
1. Write to `pending_records`:
   - `local_session_id`: `LIVE_SESSION.localSessionId` (may be null — that's correct)
   - `supabase_session_id`: `LIVE_SESSION.liveSessionId` (may be null — that's correct)
   - `sync_status: 'pending'`
2. Show the student the same success confirmation as normal — no error visible to them
3. `pendingRecordCount++`
4. Update the offline banner count

**On Postgres business-logic rejection** (error has a `.code` property like `23505`, `23503`, etc.): do NOT queue — surface the error normally as today.

**On success**: unchanged from today, nothing written to IndexedDB.

---

## Step 4 — Sync engine

```js
async function syncOfflineQueue()
```

**4a. Guards**
- If `offlineDB === null`, return
- If `syncInProgress === true`, return  (`let syncInProgress = false` at module scope)
- Ping Supabase: `GET /auth/v1/health` with anon key header, 5s timeout. On failure → return.
- Set `syncInProgress = true` in a try/finally so it always resets

**4b. Sync pending sessions first** (Scenario B — session was offline from the start)

Get all `pending_sessions` where `sync_status === 'pending'`. For each:
1. Insert into Supabase `attendance_sessions` with stored fields
2. On success → update IndexedDB record to `synced`, store returned UUID in `supabase_session_id`
3. Also update all `pending_records` that have this `local_session_id` → set their `supabase_session_id` to the new UUID
4. If `LIVE_SESSION.localSessionId` matches this record → set `LIVE_SESSION.liveSessionId` to the UUID (session is now live)
5. On failure → mark `failed`, write to `sync_log`

**4c. Sync pending records**

Get all `pending_records` where `sync_status === 'pending'`. Skip any where `supabase_session_id` is still null (parent session hasn't synced yet — will be picked up next run).

For remaining:
1. Insert into Supabase `attendance_records`
2. On success → mark `synced`, write to `sync_log`, `pendingRecordCount--`
3. On Postgres unique-constraint violation (`error.code === '23505'`) → mark `conflict`, write to `sync_log`, then insert into Supabase `fraud_logs`:
   ```js
   { student_id, course_code, session_id: supabase_session_id,
     reason: 'Duplicate check-in from offline queue — possible buddy punch',
     severity: 'medium', device_id }
   ```
4. On other failure → mark `failed`, write to `sync_log`

**4d. After sync**
- Count remaining pending records → update `pendingRecordCount`
- Call `updateOfflineBanner()`
- If any `conflict` records → show toast: "X check-in conflict(s) flagged for review"

---

## Step 5 — UI — Offline banner

Add to `index.html` (inside `<style>`):
```css
#offlineBanner {
  position: fixed; top: 0; left: 0; right: 0;
  max-width: 480px; margin: 0 auto;
  padding: 10px 16px; z-index: 9999;
  font-size: 13px; font-weight: 600; text-align: center;
  display: none; transition: background 0.3s;
}
#offlineBanner.is-offline { display: block; background: #d97706; color: #fff; }
#offlineBanner.is-synced  { display: block; background: #16a34a; color: #fff; }
```

Add `<div id="offlineBanner"></div>` to `index.html` body, before `<div id="app">`.

Add these helpers in app.js:
```js
function showOfflineBanner(queuedCount) {
  const b = document.getElementById('offlineBanner');
  if (!b) return;
  b.className = 'is-offline';
  b.textContent = `⚠ No connection — ${queuedCount} record${queuedCount !== 1 ? 's' : ''} queued locally`;
}
function showSyncedBanner(syncedCount) {
  const b = document.getElementById('offlineBanner');
  if (!b) return;
  b.className = 'is-synced';
  b.textContent = `✓ Synced ${syncedCount} record${syncedCount !== 1 ? 's' : ''}`;
  setTimeout(() => { b.className = ''; b.style.display = 'none'; }, 3000);
}
function updateOfflineBanner() {
  if (pendingRecordCount > 0) showOfflineBanner(pendingRecordCount);
  else { const b = document.getElementById('offlineBanner'); if (b) b.className = ''; }
}
```

**Live check-in count**: The Lecturer sees a running count of checked-in students during a session. When `LIVE_SESSION.localSessionId` is set (session is offline), read the count from `pending_records` filtered by `local_session_id`, not from Supabase. Make this transparent — the displayed count must be accurate in all three states (online, offline, mid-sync).

---

## Step 6 — Sync triggers

**Trigger A — network recovery event** (add near bottom of app.js, outside any function):
```js
window.addEventListener('online', () => {
  setTimeout(syncOfflineQueue, 1500);
});
```

**Trigger B — polling during active session** (in `startSession()` after session initialises):
```js
LIVE_SESSION.syncInterval = setInterval(() => {
  if (pendingRecordCount > 0) syncOfflineQueue();
}, 30000);
```
Clear it in `endSession()`:
```js
if (LIVE_SESSION.syncInterval) {
  clearInterval(LIVE_SESSION.syncInterval);
  LIVE_SESSION.syncInterval = null;
}
```

---

## Step 7 — Service worker

In `sw.js`, bump cache version from `vusap-v4` to `vusap-v5`. No other changes needed — IndexedDB is not managed by the SW.

---

## Step 8 — SQL migration file

Create `supabase/migrations/offline-sync-indexes.sql`:

```sql
-- Unique constraint that offline sync's conflict detection relies on
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'attendance_records_session_student_unique'
  ) THEN
    ALTER TABLE attendance_records
      ADD CONSTRAINT attendance_records_session_student_unique
      UNIQUE (session_id, student_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_attendance_records_session_student
  ON attendance_records(session_id, student_id);

CREATE INDEX IF NOT EXISTS idx_fraud_logs_device_id
  ON fraud_logs(device_id);
```

---

## Gotchas — read before starting

1. **`LIVE_BACKEND` does not auto-flip offline mid-session.** It's set at boot. Always catch errors at the Supabase call site (try/catch on the await). `LIVE_BACKEND` being true does not mean the next call will succeed.

2. **`resolveCheckInOutcome()` has multiple early-exit paths** — fraud detection, duplicate check, expired token. Read the whole function. Only wrap the actual `attendance_records` insert, not the outer function.

3. **`pending_records.supabase_session_id` null means two different things**: (a) session was online but the record failed → `supabase_session_id` has a real UUID; (b) session itself was offline → `supabase_session_id` is genuinely null. The sync engine handles these differently in Step 4c.

4. **Do not touch `checkFraudSignals()` or `SUSPICION_LOG`**. The conflict-handling in Step 4c adds a new fraud_log write for sync conflicts. It does not replace or interact with the real-time fraud checks.

5. **`node --check app.js` after every edit** — mandatory. The file is 5800+ lines of vanilla JS; a stray brace breaks the whole app.

6. **IndexedDB origin scoping**: data written via `file://` (local preview) and data written via the live GitHub Pages URL are in different origins. Expected behaviour — don't try to bridge them.

7. **The regression pattern**: Three previous Cowork builds silently dropped the function `restoreCheckedInStateForBroadcast()`. Before finishing, grep for it and confirm it still exists and is still called from where it was.

8. **Do not touch Data Analytics & Reports** — it's a working consumer of live data and does not need changes for offline sync.

---

## Testing checklist

Run all automated tests before marking done. The sandbox has no live Supabase route — mock `SUPABASE_CLIENT = null` and `LIVE_BACKEND = false` for offline tests, stub successful Supabase responses for sync tests.

1. **IndexedDB init** — after boot, `offlineDB !== null`
2. **Session start offline** — `startSession()` with `LIVE_BACKEND = false` → `pending_sessions` has 1 record, `LIVE_SESSION.localSessionId` is set, offline banner shows
3. **Record queue offline** — `resolveCheckInOutcome()` with `LIVE_BACKEND = false` → `pending_records` has 1 record, `pendingRecordCount === 1`, student sees success
4. **Multiple records queue** — 5 simulated scans → 5 records, banner shows "5 queued"
5. **Sync engine clears queue** — flip to online, mock Supabase inserts return success → all records `synced`, `pendingRecordCount === 0`, synced banner shows then hides
6. **Conflict handling** — mock insert returns `{ code: '23505' }` → record marked `conflict`, fraud_log write attempted, conflict toast shown
7. **Session backfill** — session started offline → records written with `supabase_session_id: null` → session syncs first → records get their `supabase_session_id` backfilled → records then sync
8. **Double-sync guard** — call `syncOfflineQueue()` twice simultaneously → second returns immediately, no duplicate writes
9. **Regression: online flow unchanged** — `startSession()` + `resolveCheckInOutcome()` with mocked successful Supabase → IndexedDB not written to, `LIVE_SESSION.localSessionId` stays null
10. **`restoreCheckedInStateForBroadcast()` exists and is called** — grep confirms it
11. **`node --check app.js` passes** — clean syntax

---

## Deliverables

Produce all of these:

1. **`/mnt/user-data/outputs/vu-attendance-preview.html`** — single self-contained file, app.js fully inlined, works via `file://` with no server
2. **`/mnt/user-data/outputs/vu-attendance-pwa.zip`** — multi-file package: `index.html`, `app.js`, `sw.js`, `manifest.json`, `icons/`
3. **`supabase/migrations/offline-sync-indexes.sql`** — the SQL from Step 8, as a standalone file
4. **Test results** — all 11 tests passing (Playwright output or equivalent)
5. **`node --check` output** — clean
6. **One-paragraph plain-English summary** of what changed, for Chris to read before testing on device

Do not produce a single zip of everything — deliver the artifacts at the exact output paths above so they match what prior builds have always produced.
