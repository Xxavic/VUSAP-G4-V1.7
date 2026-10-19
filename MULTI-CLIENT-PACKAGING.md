# QRAST — Multi-client packaging

Decision (Oct 2026): **one deployment per client** from this one template. Each institution owns its own Supabase project. Victoria University is client one on the same template.

## What differs per client
Only `client-config.js` (Supabase URL + anon key, login-email domain, ID prefix and intake code, and `demoData` — set it to `false` for every new client), plus the client's `manifest.json` text/icons and `<title>`. Everything else is shared.

Edge Function secrets per client: `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `NOTIFY_FROM_EMAIL`, and `AUTH_EMAIL_DOMAIN` (must equal `authEmailDomain` in `client-config.js`; defaults to `vusap.internal`).

## Runbook (target)
1. Create the client's Supabase project (owned by the institution; add the developer as a member).
2. Run the `migrate-*.sql` files; confirm RLS is on and there is no "Allow all" policy.
3. Deploy the Edge Functions (`create-user`, `delete-user`, `email-login`, `notify-email`, `request-password-reset`) and set the secrets above.
4. Create the first Administrator.
5. Fill `client-config.js`, edit `manifest.json`/`<title>`, host it. Add the URL to Supabase Auth redirect URLs and narrow `notify-email` CORS (see `DOMAIN-MIGRATION.md`).
6. Administrator signs in, uploads the crest, sets academic year and term dates, adds faculties and programmes.
7. Smoke test: login, enroll one student, one timetable slot, one QR scan, one notification. Confirm no Victoria data appears.

## Known gaps (not yet done)
- `@vusap.internal` to `@qrast.internal` data migration (see `migrate-auth-emails-README.md`). Until then both `authEmailDomain` and `AUTH_EMAIL_DOMAIN` stay `vusap.internal`.
- Fresh-empty-database test (`qrast-fresh-client-test-plan.md`) not yet run against a real empty project; `demoData: false` is only verified by a headless render of every screen.
- `regIntakeCode` ('2601') is still a fixed value; it does not roll over by year.
- Default crest and the `manifest.json` description are still Victoria's; default `system_settings` seed in `migrate-system-settings.sql` says "Victoria University".
- No build script or ordered SQL bundle yet.
