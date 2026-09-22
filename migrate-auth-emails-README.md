# @vusap.internal → @qrast.internal auth email migration

This is item 1 from `PENDING-DELICATE-RENAMES.md`. Two scripts, run by
you (they need your Supabase service role key, which doesn't get pasted
to Claude), plus a code change Claude will apply once you confirm the
data side is done.

## Where the domain actually gets built (found while preparing this — the
## doc's original step 4 undersold it slightly)

Three places build or check the `@vusap.internal` domain, not one:

1. `app.js`'s `universityIdToAuthEmail()` — client-side, used for login attempts.
2. `supabase/functions/create-user/index.ts` — the same helper, duplicated server-side, used when provisioning new accounts.
3. `supabase/functions/request-password-reset/index.ts` — checks whether a profile's real email is just the synthetic one, to decide reset behavior.

All three need to flip together, or new accounts / password resets will
silently keep using the old domain even after the data migration.

## Steps

1. **List.** Copy `migrate-auth-emails-1-list.mjs` anywhere on your
   machine (needs Node 18+, no `npm install` — it only uses the built-in
   `fetch`). Run it:

   ```
   SUPABASE_URL="https://<your-project>.supabase.co" \
   SUPABASE_SERVICE_ROLE_KEY="<your service role key>" \
   node migrate-auth-emails-1-list.mjs
   ```

   Produces `vusap-internal-users.json` and a `.csv` you can open and
   skim. It also flags any auth user with no matching `public.users` row
   (orphaned) or a university-id mismatch — worth a quick look before
   continuing, though neither blocks the migration itself.

2. **Dry run, then apply.** Same folder, same env vars:

   ```
   node migrate-auth-emails-2-apply.mjs            # dry run — prints only
   node migrate-auth-emails-2-apply.mjs --apply    # actually changes emails
   ```

   Safe to re-run if interrupted — anything already migrated is skipped,
   not overwritten. Writes `vusap-to-qrast-migration-results.json` with
   a per-user outcome and a summary count.

3. **Verify.** The script's own summary tells you if the migrated count
   matches expectations. Also spot-check by logging in as a couple of
   real accounts (their password hasn't changed, only the auth email —
   they'll notice nothing).

4. **Tell Claude you're ready.** Once step 3 looks clean, say so and
   Claude will flip all three code sites above from `@vusap.internal` to
   `@qrast.internal` in one commit, ready for you to deploy. Steps 2 and
   4 should happen close together (a short maintenance window) — any
   signup strictly between them would land on the old domain and need
   picking up in a second small migration pass.

## What these scripts do NOT do

- They don't touch anything in `public.users` — that table doesn't store
  the synthetic email at all (see `MOCK-DATA-AUDIT.md`'s USERS entry),
  only `auth.users` does.
- They don't deploy anything. Step 4's code change still needs a normal
  git commit + your usual deploy (GitHub Pages picks it up on push;
  `create-user` / `request-password-reset` would need
  `supabase functions deploy` same as `delete-user` did).
