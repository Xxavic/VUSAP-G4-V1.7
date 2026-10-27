# Server-side check-in (Oct 2026)

## What was wrong

The rotating QR token and the 6-digit PIN sat in plain columns on `live_qr_sessions`, a table every signed-in student can read. The student's own phone compared what they scanned or typed against those values and then inserted its own `attendance` row. A student who opened devtools could read the code of a lecture they were not in and mark themselves present from home.

The offline queue had a second problem: it took the lecture date from the phone's clock, so setting the clock back would back-date a record, and a queued check-in could sync at any age.

## What changed

| Piece | What it does |
|---|---|
| `live_qr_secrets` (new table) | Holds the token, previous token, token history and PIN. No policies, so nobody can read it through the API. |
| Trigger on `live_qr_sessions` | Moves `token` and `pin` into `live_qr_secrets` on every write and leaves NULL in the public row. Realtime therefore never carries a secret to a student. The lecturer's app writes exactly as before. |
| `check_in_to_broadcast()` | The only way a student records presence. Checks: signed in, is a student, enrolled in the broadcast's class, broadcast active (or, for a queued scan, under 24 hours old by the server clock), code correct, fewer than 10 wrong codes in 10 minutes. The lecture date and session come from the broadcast's own server start time. |
| `get_broadcast_secrets()` | Gives the token and PIN back to the lecturer who owns the broadcast, and to a Class Coordinator only while the lecturer has authorized display. Everyone else gets NULL. |
| `migrate-lock-direct-attendance-insert.sql` | Stops a student writing `attendance` rows directly through the API. Without this the check can still be skipped. |
| `app.js` | Sends the scanned token / typed PIN to the server and waits for the answer before showing "checked in". A wrong or expired code now shows a message and records nothing. Queued check-ins store the code and the broadcast's start time; on sync the broadcast is re-read from the server and the date and session are re-derived from it, so editing the stored record changes nothing. |

## What a rotated QR accepts

- **Live:** the current token, or the previous one for 15 seconds after a rotation (a scan that was in flight).
- **Queued while offline:** any token that broadcast issued, because it will have rotated by the time the phone is back online. Limit: this means a photo of the QR sent to a friend could be used later within the 24-hour window. It is the same exposure as a relayed QR online, only for longer. The shared-device and two-device fraud checks still run on sync.

## Order to deploy (this matters)

1. **Deploy the new `app.js`.** It notices the migration is missing and behaves exactly as before until it is run.
2. **Run `migrate-server-side-checkin.sql`** in the Supabase SQL Editor. Safe to run twice. From this moment the token and PIN are hidden.
3. **Test on real phones** (checklist below).
4. **Run `migrate-lock-direct-attendance-insert.sql`.** Only after step 3 works. To undo: `drop trigger attendance_block_student_insert on public.attendance;`

A phone still running an old cached copy of the app will be refused at check-in after step 4. A reload, or closing and reopening the installed app, fixes it.

## Phone checklist

1. After step 2, run the three checks at the bottom of `migrate-server-side-checkin.sql`. The first must return 0.
2. Lecturer: start a session. QR and PIN show. Reload the lecturer's page mid-session: QR and PIN come back (fetched from the server).
3. Student A: scan the QR. Checked in. Roster on the lecturer's screen shows A.
4. Student B: type the PIN. Checked in.
5. Student C: type a wrong PIN. A message appears, nothing is recorded, you can try again.
6. Student C: ten wrong PINs, then the right one. "Too many wrong codes".
7. Student D (not enrolled in the course): scan. "You're not enrolled in this course".
8. Lecturer rotates (wait one interval). Student scans a photo of the *previous* QR taken more than a minute ago: refused.
9. Class Coordinator: lecturer authorizes display. The coordinator's screen shows the QR and PIN and redraws on each rotation. Lecturer revokes: it goes back to "Not authorized".
10. Offline: student switches to airplane mode, scans, sees "saved on this phone", reconnects: it syncs and the lecturer's roster shows them. Check in Supabase that the `attendance` row's session is the lecture's real date.
11. Offline, back-dated clock: set the phone's date back two days before reconnecting. The synced row still carries the real lecture date.
12. After step 4: from the browser console as a student, an insert into `attendance` is refused with code 42501, and a normal check-in still works.

## Backup PIN (lecturer-controlled, Oct 2026)

Since cache `qrast-v56` the PIN is hidden until the lecturer taps "Generate
backup code", shows for 2 minutes, and is then replaced by one nobody has
seen. `migrate-backup-pin-expiry.sql` (run after this file) makes the server
enforce that too:

- The server stamps `live_qr_secrets.pin_set_at` whenever the PIN changes and
  accepts a PIN only for 135 seconds after it (2 minutes plus 15 s grace), so
  a code stays dead even if the lecturer's phone locks or goes offline before
  the app swaps it.
- `get_broadcast_secrets()` returns the PIN only to the owning lecturer. A
  Class Coordinator still gets the QR token, never the PIN.
- A PIN typed offline is refused if it syncs more than 135 seconds later.
  Offline students should scan the QR (accepted for 24 hours); the lecturer's
  backup-code panel says so.

## What this does not close

- A student physically in the room can still relay the QR or PIN to a friend outside. That is true of any code-based system; the rotation, the 15-second window, the device and shared-device checks, and the wrong-code lockout limit it.
- Lecturers and staff can still write `attendance` rows directly. That is deliberate (corrections, the no-show sweep).
