# Domain migration — handing VUSAP to a client institution (e.g. Victoria University)

Written Sept 2026, before any of this has actually happened, so the plan
exists before it's needed. Chris doesn't currently own a domain; this
describes what changes, in what order, and what to watch for security-wise
once a client institution is ready to put their own domain on the app.

## The four places a domain actually touches this app

"Attaching their domain" isn't one switch — it's four separate integration
points, and they don't all need to move at once:

1. **Frontend hosting URL.** Currently `xxavic.github.io/VUSAP-G4-V1.7/`
   (GitHub Pages, personal account). The institution would want something
   like `attendance.vicuni.ac.ug` instead.
2. **Supabase Auth's Site URL / Redirect URL allowlist.** Supabase checks
   every auth redirect (password reset links, magic links, etc.) against an
   allowlist configured in the Supabase Dashboard. This has to include
   whatever domain the app is actually served from, or those flows break.
3. **The email-sending domain** (Resend, or whatever ESP is in use by
   then). Needs the institution's own domain verified via DNS (DKIM/SPF/
   DMARC — see security section), not a domain Chris personally registered.
4. **(Optional, later)** Supabase itself supports a custom domain for the
   API endpoint (`api.vicuni.ac.ug` instead of the default
   `*.supabase.co` URL) — a paid-tier feature, cosmetic/optional, not
   required for the app to function correctly.

## The ownership conversation that has to happen first — before any DNS work

Right now, everything sits under Chris's personal accounts: the GitHub
repo, the Supabase project, and (once set up) the email-sending account.
Before attaching an institution's domain, there should be an explicit
conversation about who owns what going forward:

- The **domain and DNS** should be registered/controlled by the
  institution itself (their IT department, or whoever manages
  `vu.ac.ug` already) — never a domain in Chris's personal name attached
  to an institutional system. If the institution already owns a domain,
  this is just picking a subdomain (e.g. `attendance.vu.ac.ug`) rather
  than buying anything new.
- The **Supabase project** should at minimum have the institution's IT
  contact added as a project member/owner, so they have real, permanent
  access — not just Chris's personal login standing between them and
  their own data.
- The **email-sending account** (Resend or otherwise) should ideally be
  the institution's own account, billed and controlled by them, since
  it's sending mail on their behalf to their own staff.
- Whatever **secrets** Chris personally holds during development
  (`SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, any admin account
  passwords) should be rotated once ownership actually transfers — not
  because of any specific distrust, just standard practice: a departing
  developer shouldn't retain live access to production secrets
  indefinitely.

## When in the deployment sequence this belongs

Not a "whenever's convenient" step — order matters, mainly because auth
redirects and email deliverability both depend on the domain being live
*before* things start pointing at it.

1. **Ownership handoff conversation** (above) — settled before any
   technical work starts.
2. **Institution confirms the domain/subdomain name** — e.g. decides on
   `attendance.vu.ac.ug`.
3. **Add the new domain to Supabase Auth's Site URL / Redirect URLs
   *alongside* the existing GitHub Pages one** — don't remove the old one
   yet. Both need to be valid during the transition window so nobody gets
   logged out or hits a broken reset-password link mid-cutover.
4. **Point DNS at GitHub Pages** — a CNAME record at the institution's DNS
   host, then add the custom domain in the repo's GitHub Pages settings,
   and confirm "Enforce HTTPS" is checked once GitHub finishes issuing the
   certificate (this can take a few minutes to a few hours after the DNS
   record goes live).
5. **Re-check the PWA manifest and service worker scope.** The app is
   currently served from a GitHub Pages *project* path
   (`/VUSAP-G4-V1.7/`), not the domain root. Under a custom domain it'll
   likely serve from root (`/`) instead — the manifest's `start_url` and
   the service worker's registration scope need to match wherever it
   actually ends up, or the "Add to Home Screen" install can break.
6. **Verify the sending domain in the email provider** and set up DKIM +
   SPF + DMARC (not just DKIM alone — see security section), then update
   the `NOTIFY_FROM_EMAIL` secret to an address on the new domain.
7. **Tighten `notify-email`'s CORS from `*` to the exact new origin**
   (see security section) — this is safe to do only once the final domain
   is known and stable.
8. **Cutover window**: switch users over to the new URL, verify
   everything end-to-end (login, QR check-in, notifications, email), then
   only after that's confirmed working — remove the old GitHub Pages
   domain from the Supabase Auth allowlist.

## Security protocols to observe

- **DNS/registrar account security.** Whoever's registrar account holds
  the domain should have 2FA turned on. Anyone who gains access to the
  domain's DNS can redirect the entire app, intercept auth flows, or
  impersonate the institution in email — this is a genuinely high-value
  target, not a minor account.
- **SPF + DKIM + DMARC together, not DKIM alone.** DKIM alone (what the
  Resend screen showed) proves the email wasn't tampered with in transit,
  but doesn't stop someone else from sending mail that *claims* to be from
  the domain. SPF declares which servers are allowed to send as that
  domain; DMARC tells receiving mail servers what to do with messages that
  fail those checks (start with `p=none` to monitor, then move to
  `p=quarantine` or `p=reject` once confident nothing legitimate is being
  blocked). All three together is the real anti-spoofing setup, and is
  worth doing properly for an institutional domain even though the
  DKIM-only Resend flow will technically "work" without it.
- **Auth redirect allowlist hygiene.** Remove the old GitHub Pages domain
  from Supabase's Redirect URLs once cutover is confirmed — a stale
  allowlist entry pointing at a domain nobody controls anymore is a
  standing open-redirect risk for password reset / magic link flows.
- **CORS should end up domain-specific, not wildcard.** `notify-email`
  currently allows `Access-Control-Allow-Origin: *`, which was the right
  call during development (URL wasn't final yet) but should be narrowed to
  the institution's exact production origin once it's settled — a wildcard
  lets any website's JavaScript call the function from a visitor's
  browser.
- **HTTPS enforcement, confirmed not assumed.** GitHub Pages usually
  auto-provisions a certificate for a custom domain, but the "Enforce
  HTTPS" checkbox sometimes isn't selectable for a few minutes to hours
  after the DNS record first goes live — don't consider cutover done until
  that box is actually checked.
- **Secret rotation on ownership transfer** — covered above under
  ownership, worth repeating here as a security item specifically: rotate
  `SUPABASE_SERVICE_ROLE_KEY` and `RESEND_API_KEY` at handoff, not just
  hand over the existing ones.
- **DNS propagation and rollback planning.** DNS changes can take
  anywhere from minutes to ~48 hours to fully propagate depending on TTLs
  and the resolver a given user hits. Plan the cutover with a window, not
  as a last-minute switch right before the app needs to be in active use,
  and keep the old URL functional until the new one is verified working
  for real users.
