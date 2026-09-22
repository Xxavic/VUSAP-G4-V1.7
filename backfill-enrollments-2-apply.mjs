#!/usr/bin/env node
// Enrollment backfill, step 2.
//
// Reads students-missing-enrollments.json (produced by
// backfill-enrollments-1-list.mjs) and inserts the matched enrollments
// rows for each student who still has zero.
//
// SAFE BY DEFAULT: without --apply, this only prints what it WOULD do.
// Nothing is written until you pass --apply explicitly.
//
// Idempotent: re-checks each student's live enrollment count right
// before writing, and skips anyone who already has at least one row by
// then (e.g. handled by a previous partial run, or by the ordinary
// auto-enrollment path if they happened to re-register in the meantime).
//
// Run this yourself -- it needs your service role key, which never gets
// pasted to Claude. Usage:
//
//   Dry run (no changes):
//     SUPABASE_URL="https://xxxx.supabase.co" \
//     SUPABASE_SERVICE_ROLE_KEY="eyJ..." \
//     node backfill-enrollments-2-apply.mjs
//
//   Actually apply:
//     SUPABASE_URL="https://xxxx.supabase.co" \
//     SUPABASE_SERVICE_ROLE_KEY="eyJ..." \
//     node backfill-enrollments-2-apply.mjs --apply
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

const headers = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

async function currentEnrollmentCount(studentId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/enrollments?select=student_id&student_id=eq.${studentId}&limit=1`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Lookup failed: ${res.status} ${body}`);
  }
  const rows = await res.json();
  return rows.length;
}

async function insertEnrollments(studentId, classIds) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/enrollments`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify(classIds.map(classId => ({ student_id: studentId, class_id: classId }))),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${body}`);
  }
}

async function main() {
  const fs = await import('node:fs/promises');
  let rows;
  try {
    rows = JSON.parse(await fs.readFile('students-missing-enrollments.json', 'utf-8'));
  } catch (e) {
    console.error('Could not read students-missing-enrollments.json -- run backfill-enrollments-1-list.mjs first.');
    process.exit(1);
  }

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to actually make changes)'} -- ${rows.length} student(s) loaded.\n`);

  const results = [];
  for (const row of rows) {
    const label = `${row.universityId} (${row.name})`;

    if (row.matchedClassCount === 0) {
      console.log(`[SKIP] ${label}: 0 matched classes -- set Year on the relevant courses in Course Catalog first.`);
      results.push({ ...row, outcome: 'no_matched_classes' });
      continue;
    }

    let current;
    try {
      current = await currentEnrollmentCount(row.studentId);
    } catch (e) {
      console.error(`[SKIP] ${label}: could not check current enrollments -- ${e.message}`);
      results.push({ ...row, outcome: 'lookup_failed', error: e.message });
      continue;
    }

    if (current > 0) {
      console.log(`[SKIP] ${label}: already has enrollment rows -- not touching.`);
      results.push({ ...row, outcome: 'skipped_already_enrolled' });
      continue;
    }

    if (!APPLY) {
      console.log(`[DRY RUN] ${label}: would insert ${row.matchedClassCount} enrollment row(s).`);
      results.push({ ...row, outcome: 'dry_run' });
      continue;
    }

    try {
      await insertEnrollments(row.studentId, row.matchedClassIds);
      console.log(`[OK] ${label}: inserted ${row.matchedClassCount} enrollment row(s).`);
      results.push({ ...row, outcome: 'enrolled' });
    } catch (e) {
      console.error(`[FAIL] ${label}: ${e.message}`);
      results.push({ ...row, outcome: 'failed', error: e.message });
    }
  }

  const counts = results.reduce((acc, r) => { acc[r.outcome] = (acc[r.outcome] || 0) + 1; return acc; }, {});
  console.log('\n=== Summary ===');
  Object.entries(counts).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

  await fs.writeFile('backfill-enrollments-results.json', JSON.stringify(results, null, 2));
  console.log('\nFull results written to backfill-enrollments-results.json.');

  if (APPLY) {
    const enrolled = counts.enrolled || 0;
    const expected = rows.length - (counts.skipped_already_enrolled || 0) - (counts.no_matched_classes || 0);
    console.log(`\nEnrolled ${enrolled} of ${expected} eligible student(s).`);
    if (enrolled !== expected) {
      console.log('COUNT MISMATCH -- check the failed/lookup_failed entries above.');
    } else {
      console.log('Counts match. Spot-check a student\'s timetable in the app to confirm.');
    }
  } else {
    console.log('\nThis was a dry run -- nothing was changed. Re-run with --apply when ready.');
  }
}

main().catch((e) => {
  console.error('\nFailed:', e.message || e);
  process.exit(1);
});
