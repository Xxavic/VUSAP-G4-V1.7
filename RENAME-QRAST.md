# Rebrand log: VUSAP → QRAST

**Date:** 2026-09-18
**Commit:** `f406e57` — "Rename product brand from VUSAP to QRAST"
**Scope:** code-only, reversible rename of the software product's own brand
name (`SYSTEM_SETTINGS.systemName`). This is a placeholder rename done now
because it's free and safe; it does not imply the product has launched
publicly or been renamed for good.

**Not in scope / not touched:** "Victoria University" institution
references (`SYSTEM_SETTINGS.institutionName`) — those stay correct for the
current live deployment and are a separate setting entirely. Domain
purchase (qrast.ug / qrast.app) and URSB trademark filing were explicitly
deferred by Chris until the product is actually ready to launch to other
institutions — nothing was bought or filed.

## Why QRAST

Landed on QRAST after checking several candidates. QRAMS was ruled out —
already a registered UK trademark (Nice Class 42, UK00004220231). QRAST
came back with no results on the WIPO Global Brand Database, and qrast.ug /
qrast.app were both available (qrast.com is already registered/parked, but
that's not needed for now).

## Files changed

| File | What changed |
|---|---|
| `app.js` | UI brand labels, toast messages, notification templates, print/report titles, the `systemName` default, and four lowercase downloaded-file prefixes (e.g. `vusap-attendance-...csv` → `qrast-attendance-...csv`) |
| `index.html` | `<title>`, PWA meta tags, splash screen, install-prompt text |
| `manifest.json` | `name`, `short_name` (the `description` field was left as "Victoria University Smart Attendance Portal" — that's institution-specific, not the product's brand name) |
| `sw.js` | header comment, `CACHE_NAME` (bumping this triggers a normal one-time service-worker cache rebuild, not a break) |
| `migrate-consent-and-support-tickets.sql` | one comment line |
| `migrate-system-settings.sql` | `system_name` column default, so a future fresh install/fork starts from "QRAST" instead of "VUSAP" |
| `supabase/functions/notify-email/index.ts` | header/setup comments + the fallback `FROM` sender name used when the `NOTIFY_FROM_EMAIL` secret isn't set |
| `DOMAIN-MIGRATION.md` | title line only |
| `NOTIFICATIONS.md` | three prose mentions of the product name |

## Deliberately left unchanged

These are internal, invisible identifiers tied to data that already exists
in the live system. Renaming them would either break something for
existing users right now, or change nothing anyone can see while adding
risk:

- `'vusap-auth-token'` — Supabase Auth's own localStorage session key.
  Renaming logs out every currently signed-in user.
- `'@vusap.internal'` — the synthetic email domain used to build login
  emails for university-ID-based accounts. Existing Supabase Auth users
  were created with this exact domain; renaming breaks their login lookup.
- `'vusap-theme'`, `'vusap-device-id'`, `'vusap-timetable-claims'` —
  localStorage keys for theme preference, device fingerprinting, and
  timetable claims. Renaming just resets continuity for existing users.
- The QR code's internal protocol marker (`'VUSAP|...'`) — never shown to
  a user, regenerated fresh every session (not persisted), so there's no
  real benefit to changing it.
- History-API navigation state property names (`vusapScreen`, etc.) —
  in-memory only, used solely for the SPA's own back/forward handling.
- `design/vusap-redesign-preview.html` — an unused, unlinked design
  mockup (not part of the served app; its actual title is "Campus Pulse,"
  a different exploratory concept). Left alone entirely.
- Two lines that describe the *actual* GitHub repo path
  (`xxavic.github.io/VUSAP-G4-V1.7/`) and one that names the file
  `VUSAP-vs-MakBAMS-comparison.md` — still accurate, since the repo itself
  hasn't been renamed.

## Manual steps still needed (can't be done from code)

1. **Live display name:** the app reads `systemName` from the Supabase
   `system_settings` table first, only falling back to the JS default if
   that's null. The already-stored row still says "VUSAP." To make the
   live site actually show "QRAST," log in as Administrator → System
   Settings and update the System Name field there.
2. **Email sender name:** the `notify-email` edge function's fallback
   sender name was changed in source, but that only takes effect once the
   function is redeployed: `supabase functions deploy notify-email`.

## Verification performed

- `node --check app.js` and `node --check sw.js` — both passed.
- `manifest.json` — validated as parseable JSON.
- Repo-wide grep for `VUSAP` after the rename — only the intentional
  leave-alones listed above remained; nothing missed, nothing over-reached.

## Deferred (not part of this rename)

- Purchasing qrast.ug / qrast.app.
- Filing a trademark with URSB (Uganda Registration Services Bureau).

Both are parked until there's an actual public launch to other
institutions.
