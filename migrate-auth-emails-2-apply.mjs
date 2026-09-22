#!/usr/bin/env node
// PENDING-DELICATE-RENAMES.md item 1, step 2.
//
// Reads vusap-internal-users.json (produced by
// migrate-auth-emails-1-list.mjs) and updates each auth user's email from
// <id>@vusap.internal to <id>@qrast.internal via the Admin API.
//
// SAFE BY DEFAULT: without --apply, this only prints what it WOULD do.
// Nothing is written until you pass --apply explicitly.
//
// Idempotent: safe to re-run if interrupted -- any row whose live email no
// longer ends in @vusap.internal (already migrated, or changed by someone
// in the meantime) is skipped rather than overwritten.
//
// Run this yourself -- it needs your service role key, which never gets
// pasted to Claude. Usage:
//
//   Dry run (no changes):
//     SUPABASE_URL="https://xxxx.supabase.co" \
//     SUPABASE_SERVICE_ROLE_KEY="eyJ..." \
//     node migrate-auth-emails-2-apply.mjs
//
//   Actually apply:
//     SUPABASE_URL="https://xxxx.supabase.co" \
//     SUPABASE_SERVICE_ROLE_KEY="eyJ..." \
//     node migrate-auth-emails-2-apply.mjs --apply
//
// Needs Node 18+ (uses the built-in fetch). No npm install required.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APPLY = process.argv.includes('--apply');

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable.');
  console.error('Set both, then re-run. See the comment at the top of this file for the exact command.');
  process.exit(1);
}

const authHeaders = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

async function getCurrentEmail(userId) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { headers: authHeaders });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Lookup failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  return data?.email || data?.user?.email || null;
}

async function updateEmail(userId, newEmail) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ email: newEmail, email_confirm: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${body}`);
  }
  return res.json();
}

async function main() {
  const fs = await import('node:fs/promises');
  let rows;
  try {
    rows = JSON.parse(await fs.readFile('vusap-internal-users.json', 'utf-8'));
  } catch (e) {
    console.error('Could not read vusap-internal-users.json -- run migrate-auth-emails-1-list.mjs first.');
    process.exit(1);
  }

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to actually make changes)'} -- ${rows.length} row(s) loaded.\n`);

  const results = [];
  for (const row of rows) {
    let current;
    try {
      current = await getCurrentEmail(row.id);
    } catch (e) {
      console.error(`[SKIP] ${row.id} (${row.profile_university_id ?? '?'}): could not look up current email -- ${e.message}`);
      results.push({ ...row, outcome: 'lookup_failed', error: e.message });
      continue;
    }

    if (!current || !current.toLowerCase().endsWith('@vusap.internal')) {
      console.log(`[SKIP] ${row.id} (${row.profile_university_id ?? '?'}): current email is already "${current}" -- not on @vusap.internal, leaving alone.`);
      results.push({ ...row, outcome: 'skipped_already_migrated', current_email_at_run_time: current });
      continue;
    }

    if (!APPLY) {
      console.log(`[DRY RUN] ${row.id} (${row.profile_university_id ?? '?'}): would change "${current}" -> "${row.new_email}"`);
      results.push({ ...row, outcome: 'dry_run' });
      continue;
    }

    try {
      await updateEmail(row.id, row.new_email);
      console.log(`[OK] ${row.id} (${row.profile_university_id ?? '?'}): "${current}" -> "${row.new_email}"`);
      results.push({ ...row, outcome: 'migrated' });
    } catch (e) {
      console.error(`[FAIL] ${row.id} (${row.profile_university_id ?? '?'}): ${e.message}`);
      results.push({ ...row, outcome: 'failed', error: e.message });
    }
  }

  const counts = results.reduce((acc, r) => { acc[r.outcome] = (acc[r.outcome] || 0) + 1; return acc; }, {});
  console.log('\n=== Summary ===');
  Object.entries(counts).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

  await fs.writeFile('vusap-to-qrast-migration-results.json', JSON.stringify(results, null, 2));
  console.log('\nFull results written to vusap-to-qrast-migration-results.json.');

  if (APPLY) {
    const migrated = counts.migrated || 0;
    const expected = rows.length - (counts.skipped_already_migrated || 0);
    console.log(`\nMigrated ${migrated} of ${expected} row(s) not already on qrast.internal.`);
    if (migrated !== expected) {
      console.log('COUNT MISMATCH -- check the failed/lookup_failed entries above before moving on to step 3/4.');
    } else {
      console.log('Counts match. Spot-check a couple of logins (step 3), then let Claude know you\'re ready for step 4 (flipping the code).');
    }
  } else {
    console.log('\nThis was a dry run -- nothing was changed. Re-run with --apply when ready.');
  }
}

main().catch((e) => {
  console.error('\nFailed:', e.message || e);
  process.exit(1);
});
