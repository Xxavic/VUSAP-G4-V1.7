# Notifications & Email — how it works

This documents VUSAP's notification system: what triggers an in-app
notification, and — separately — what triggers an actual email. Written
Sept 2026 so this doesn't need to be re-explained/re-discovered later.

## Two layers, not one

Every notification in VUSAP goes through `pushNotification()` in `app.js`.
That function always does two things:

1. Writes the notification to the in-app inbox (the bell icon) — every
   role sees these, always, regardless of anything below.
2. Fires `liveSendEmailNotification()` as a fire-and-forget side effect.

**Email is the exception, not the default.** `liveSendEmailNotification()`
only actually sends when `recipientRole` is `'registrar'` or
`'administrator'` — see the guard at the top of that function in `app.js`
(search `recipientRole !== 'registrar' && recipientRole !== 'administrator'`).
Students and Lecturers never get emailed by VUSAP; they're expected to
check the in-app inbox, which they do daily by design.

## When a Registrar gets emailed

- A high-severity fraud flag is raised (broadcasts to all Registrars).
- A Lecturer overrides a student's already-recorded attendance status
  (goes to that student's faculty Registrar specifically).
- A lecturer compliance report is flagged (broadcasts to all Registrars).
- A Student or Lecturer in their faculty submits a new support ticket.
- Someone (usually the Administrator) manually sends them a message via
  Compose Notification, targeting "All Registrars" or a specific one.

## When the Administrator gets emailed

- A Registrar submits their own support ticket (tickets from a Registrar
  escalate straight to the Administrator, 2nd line of support).
- A Registrar's own submitted ticket gets resolved (the "your report was
  resolved" notification only emails if the original reporter was a
  Registrar — a Student/Lecturer having their ticket resolved stays
  in-app only).

## Everything that stays in-app only

QR Class Coordinator authorization, announcements, class reschedule
notices to Students/Lecturers, and "your report was resolved" when the
reporter was a Student or Lecturer — these all call `pushNotification()`
with `recipientRole: 'student'` or `'lecturer'`, so the email guard above
blocks them by design.

## For email to actually go out (infrastructure status)

Two things have to be true, independent of the trigger logic above:

1. **The `notify-email` Edge Function must be deployed** —
   `supabase functions deploy notify-email` from the project root. The
   function's own code is CORS-safe as of the Sept 2026 fix (it used to
   fail every call with a CORS preflight error).
2. **`RESEND_API_KEY` must be set** — `supabase secrets set
   RESEND_API_KEY=re_xxxxxxxx`. Without it, the function safely no-ops
   (`{skipped:true}`) rather than erroring — nothing breaks, emails just
   silently don't send. **As of this writing, whether this secret is set
   is unconfirmed** — check `supabase secrets list` if emails aren't
   arriving.

See `supabase/functions/notify-email/index.ts` for the full setup notes
(provider, domain verification, etc.) — they're written at the top of
that file.

## If you want to change any of this

- To add email for Students/Lecturers too: edit the role guard at the top
  of `liveSendEmailNotification()` in `app.js`.
- To change *which* events notify at all (not just email): search
  `pushNotification({` in `app.js` — every call site is a distinct
  trigger, listed above.
- To change who receives an email for an existing trigger (e.g. scope the
  fraud flag to one faculty instead of broadcasting to all Registrars):
  edit that call site's `recipientId` argument — `null` means "everyone
  with this role"; a specific id (often via `registrarIdForFacultyKey()`)
  scopes it to one person.
