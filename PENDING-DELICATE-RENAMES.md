# Pending delicate renames — VUSAP → QRAST (do together, on request)

These are the "VUSAP" spots that were deliberately left alone during the
QRAST rename because they're tied to data or infrastructure that already
exists live, not just display text. None of these are urgent. When you're
ready for one, just say so — e.g. "let's do the auth email domain one," or
"handle item 1 from the delicate list" — and I'll come back to this file
and work through its steps. As always: I'll deliver a migration/script for
you to review before anything touches schema, auth, or production data —
I won't run it myself.

---

## 1. `@vusap.internal` synthetic auth email domain — the real one

**What it is:** `app.js` builds a fake login email for university-ID-based
accounts as `${universityId}@vusap.internal`, used to look accounts up in
Supabase Auth.

**Why it's delicate:** every existing student/lecturer/registrar account
was created with a real stored email ending in `@vusap.internal`. If the
code alone switches to `@qrast.internal`, every existing user's login
lookup breaks instantly — this needs the data migrated first.

**Steps when ready:**
1. I pull a list of all Supabase Auth users whose email ends in
   `@vusap.internal` (via the Admin API, using your service role key —
   which you'd run, not paste to me).
2. I write a one-off script that updates each of those `auth.users.email`
   values to the `@qrast.internal` equivalent. You review it, then run it
   yourself.
3. We verify the migrated count matches the list from step 1, and spot-
   check a couple of logins.
4. Only then do I flip the code that builds new login emails from
   `@vusap.internal` to `@qrast.internal`, and it gets deployed.
5. Steps 2 and 4 should happen close together (a short maintenance
   window) — any signup that happens strictly between them would land on
   the old domain and need picking up separately.

---

## 2. `vusap-auth-token` localStorage key — low risk, but touches every session

**What it is:** the key Supabase Auth uses in the browser's localStorage
to store the signed-in session.

**Why it's semi-delicate:** purely client-side, no server data involved —
but if renamed with no extra handling, every currently-logged-in user's
browser looks for the old key, doesn't find it, and they're logged out
(not locked out — their account is fine, they just have to sign in again).

**Steps when ready:**
1. Change `storageKey: 'vusap-auth-token'` to `storageKey:
   'qrast-auth-token'` in the Supabase client init.
2. Add a small one-time migration snippet in the app's boot code: if the
   new key is empty but the old `vusap-auth-token` key still has a value,
   copy it over before the Supabase client initializes. Done this way,
   nobody gets logged out at all.
3. Test locally (stay logged in through the change), then deploy.

---

## 3. Other localStorage keys — `vusap-theme`, `vusap-device-id`, `vusap-timetable-claims`

**What they are:** theme preference, device fingerprint (used for fraud
heuristics), and claimed-timetable-slot tracking, all stored locally per
browser.

**Why they're listed here at all:** same shape as #2 — cosmetic rename,
minor one-time reset if done carelessly (theme reverts to default, device
stops being "recognized," a claimed slot needs re-claiming).

**Steps when ready:** same fallback-copy trick as #2, batched together in
one pass since they're the same pattern. Genuinely low priority — fine to
bundle with #2 whenever that happens, or skip indefinitely.

---

## 4. GitHub repo rename + custom domain — the big one

**What it is:** the actual GitHub repo is still `VUSAP-G4-V1.7`, live at
`xxavic.github.io/VUSAP-G4-V1.7/`. This is the same thing as the domain
purchase / URSB trademark work you already told me to park until you're
ready to launch publicly — listing it here just so it's in the same
place as everything else.

**Why it's delicate:** it's not just a rename — it changes the live URL
everyone uses, and Supabase Auth has an "allowed redirect URLs" allowlist
that has to include the new domain or login/auth flows will break the
moment you switch.

**Steps when ready:**
1. You decide it's time (buy `qrast.ug` / `qrast.app` — both were
   available when checked; `qrast.com` is taken/parked).
2. File the URSB trademark if you still want to at that point.
3. Rename the GitHub repo (or set up the custom domain under GitHub
   Pages settings) and point DNS at it.
4. Update the two leftover repo-path references (in
   `DOMAIN-MIGRATION.md`) to match.
5. Add the new domain to Supabase's allowed redirect URLs *before*
   switching traffic over, not after.
6. Test the new URL end-to-end before retiring the old one.

---

## Lower tier — genuinely no risk, no coordination needed, say the word anytime

These cost nothing to change and gain nothing by changing — they were
left alone purely because there's no upside, not because they're risky.
No need to "call it" for these specifically; just mention it and I'll
knock them out in a few minutes:

- QR code's internal protocol marker string (never shown to a user,
  regenerated fresh every session)
- History API navigation state property names (`vusapScreen`, etc.) —
  in-memory only
- `design/vusap-redesign-preview.html` — unused, unlinked design mockup
  (can rename, edit, or just delete it, your call)
