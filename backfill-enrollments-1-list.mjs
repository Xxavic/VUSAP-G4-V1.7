#!/usr/bin/env node
// Enrollment backfill, step 1 — for students created BEFORE the
// auto-enrollment fix (handleEnroll() -> autoEnrollStudentInCourses()),
// who therefore still have zero rows in `enrollments` today.
//
// Read-only. Finds every live student profile with no enrollments row at
// all, matches them against `classes` by programme + year + mode (the
// same matching autoEnrollStudentInCourses() now does at signup time),
// and writes a preview you can check before applying anything.
//
// PREREQUISITE: classes.year needs to actually be set on your existing
// courses first (Course Catalog -> Edit Course -> Year), or every
// student here will show 0 matched classes no matter what. Run this
// AFTER you've gone through and tagged your courses, not before.
//
// Run this yourself -- it needs your service role key, which never gets
// pasted to Claude. Usage:
//
//   SUPABASE_URL="https://xxxx.supabase.co" \
//   SUPABASE_SERVICE_ROLE_KEY="eyJ..." \
//   node backfill-enrollments-1-list.mjs
//
// Needs Node 18+ (uses the built-in fetch). No npm install required.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

async function fetchAll(path, selectQuery, extraFilter) {
  // Simple offset pager, 1000 rows at a time -- fine for the table sizes
  // here (students/classes/enrollments). extraFilter is an optional extra
  // PostgREST query-string segment (e.g. "role=eq.student"), kept separate
  // from selectQuery so the URL construction stays readable.
  const rows = [];
  let offset = 0;
  const pageSize = 1000;
  for (;;) {
    const filterPart = extraFilter ? `&${extraFilter}` : '';
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}?select=${selectQuery}${filterPart}&limit=${pageSize}&offset=${offset}`, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Fetch ${path} failed: ${res.status} ${body}`);
    }
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  console.log(`Fetching programmes, classes, students, and enrollments from ${SUPABASE_URL} ...`);

  const [programmes, classes, students, enrollmentRows] = await Promise.all([
    fetchAll('programmes', 'id,name'),
    fetchAll('classes', 'id,programme_id,year,mode'),
    fetchAll('users', 'id,university_id,name,program,year,mode', 'role=eq.student'),
    fetchAll('enrollments', 'student_id'),
  ]);

  console.log(`Programmes: ${programmes.length}, Classes: ${classes.length}, Students: ${students.length}, Enrollment rows: ${enrollmentRows.length}`);

  const programmeIdByName = {};
  programmes.forEach(p => { programmeIdByName[p.name] = p.id; });

  const studentIdsWithEnrollments = new Set(enrollmentRows.map(e => e.student_id));
  const studentsMissing = students.filter(s => !studentIdsWithEnrollments.has(s.id));

  console.log(`Students with zero enrollment rows: ${studentsMissing.length}`);

  if (studentsMissing.length === 0) {
    console.log('Nothing to backfill. Exiting.');
    return;
  }

  const rows = studentsMissing.map(s => {
    const programmeId = s.program ? programmeIdByName[s.program] : null;
    const matched = (programmeId && s.year)
      ? classes.filter(c => c.programme_id === programmeId && c.year === s.year && (!c.mode || c.mode === s.mode))
      : [];
    return {
      studentId: s.id,
      universityId: s.university_id,
      name: s.name,
      program: s.program,
      year: s.year,
      mode: s.mode,
      programmeResolved: !!programmeId,
      matchedClassIds: matched.map(c => c.id),
      matchedClassCount: matched.length,
    };
  });

  const noProgramme = rows.filter(r => r.program && !r.programmeResolved);
  const zeroMatches = rows.filter(r => r.matchedClassCount === 0);
  if (noProgramme.length) {
    console.warn(`\nWARNING: ${noProgramme.length} student(s) have a "program" value that doesn't match any row in your programmes table by name. Review these -- likely a stale/renamed programme.`);
  }
  if (zeroMatches.length) {
    console.warn(`WARNING: ${zeroMatches.length} student(s) matched zero classes -- almost always means "year" isn't set yet on the classes.year column) for that programme/year. Set it in Course Catalog, then re-run this script.`);
  }

  const fs = await import('node:fs/promises');
  await fs.writeFile('students-missing-enrollments.json', JSON.stringify(rows, null, 2));

  const csvHeader = 'studentId,universityId,name,program,year,mode,programmeResolved,matchedClassCount';
  const csvLines = rows.map(r => [
    r.studentId, r.universityId, r.name, r.program, r.year, r.mode, r.programmeResolved, r.matchedClassCount,
  ].map(csvEscape).join(','));
  await fs.writeFile('students-missing-enrollments.csv', [csvHeader, ...csvLines].join('\n') + '\n');

  console.log(`\nWrote students-missing-enrollments.json and .csv (${rows.length} students).`);
  console.log('Open the .csv and skim it -- especially matchedClassCount -- then run backfill-enrollments-2-apply.mjs (dry-run first).');
}

main().catch((e) => {
  console.error('\nFailed:', e.message || e);
  process.exit(1);
});
