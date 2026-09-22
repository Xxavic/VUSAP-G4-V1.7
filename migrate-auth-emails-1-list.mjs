#!/usr/bin/env node
// PENDING-DELICATE-RENAMES.md item 1, step 1.
//
// Read-only. Lists every Supabase Auth user whose email ends in
// "@vusap.internal", cross-references each against public.users for a
// university_id/role sanity check, and writes the result to
// vusap-internal-users.json (consumed by step 2's script) and a
// human-readable .csv you can open and skim.
//
// Run this yourself -- it needs your service role key, which never gets
// pasted to Claude. Usage:
//
//   SUPABASE_URL="https://xxxx.supabase.co" \
//   SUPABASE_SERVICE_ROLE_KEY="eyJ..." \
//   node migrate-auth-emails-1-list.mjs
//
// Needs Node 18+ (uses the built-in fetch). No npm install required.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable.');
  console.error('Set both, then re-run. See the comment at the top of this file for the exact command.');
  process.exit(1);
}

const authHeaders = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
};

async function listAllAuthUsers() {
  const users = [];
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, {
      headers: authHeaders,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`List users failed (page ${page}): ${res.status} ${body}`);
    }
    const data = await res.json();
    const batch = data.users || [];
    users.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
  }
  return users;
}

async function fetchProfilesByAuthIds(authIds) {
  // PostgREST 'in' filter, chunked to keep the URL a sane length.
  const profiles = {};
  const chunkSize = 200;
  for (let i = 0; i < authIds.length; i += chunkSize) {
    const chunk = authIds.slice(i, i + chunkSize);
    const filter = encodeURIComponent(`(${chunk.join(',')})`);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/users?select=id,university_id,role,name&id=in.${filter}`,
      { headers: { ...authHeaders, 'Content-Type': 'application/json' } }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Profile lookup failed: ${res.status} ${body}`);
    }
    const rows = await res.json();
    rows.forEach((r) => { profiles[r.id] = r; });
  }
  return profiles;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  console.log(`Fetching all Supabase Auth users from ${SUPABASE_URL} ...`);
  const allUsers = await listAllAuthUsers();
  console.log(`Total auth users: ${allUsers.length}`);

  const vusapUsers = allUsers.filter((u) => (u.email || '').toLowerCase().endsWith('@vusap.internal'));
  console.log(`Users on @vusap.internal: ${vusapUsers.length}`);

  if (vusapUsers.length === 0) {
    console.log('Nothing to migrate. Exiting.');
    return;
  }

  const profiles = await fetchProfilesByAuthIds(vusapUsers.map((u) => u.id));

  const rows = vusapUsers.map((u) => {
    const universityId = u.email.replace(/@vusap\.internal$/i, '');
    const profile = profiles[u.id];
    return {
      id: u.id,
      current_email: u.email,
      new_email: `${universityId}@qrast.internal`,
      university_id_from_email: universityId,
      profile_university_id: profile?.university_id ?? null,
      profile_role: profile?.role ?? null,
      profile_name: profile?.name ?? null,
      has_profile_row: !!profile,
      mismatch: !!profile && profile.university_id !== universityId,
    };
  });

  const noProfile = rows.filter((r) => !r.has_profile_row);
  const mismatched = rows.filter((r) => r.mismatch);
  if (noProfile.length) {
    console.warn(`\nWARNING: ${noProfile.length} auth user(s) have no matching public.users row (orphaned auth accounts). They'll still be listed, but review these by hand -- migrating their email won't hurt, but they may be leftover test/orphan accounts worth cleaning up separately.`);
  }
  if (mismatched.length) {
    console.warn(`WARNING: ${mismatched.length} auth user(s) whose email-derived ID doesn't match their profile's university_id. Review these individually before migrating.`);
  }

  const fs = await import('node:fs/promises');
  await fs.writeFile('vusap-internal-users.json', JSON.stringify(rows, null, 2));

  const csvHeader = 'id,current_email,new_email,profile_university_id,profile_role,profile_name,has_profile_row,mismatch';
  const csvLines = rows.map((r) => [
    r.id, r.current_email, r.new_email, r.profile_university_id, r.profile_role, r.profile_name, r.has_profile_row, r.mismatch,
  ].map(csvEscape).join(','));
  await fs.writeFile('vusap-internal-users.csv', [csvHeader, ...csvLines].join('\n') + '\n');

  console.log(`\nWrote vusap-internal-users.json and vusap-internal-users.csv (${rows.length} rows).`);
  console.log('Open the .csv and skim it, then run migrate-auth-emails-2-apply.mjs (dry-run first).');
}

main().catch((e) => {
  console.error('\nFailed:', e.message || e);
  process.exit(1);
});
