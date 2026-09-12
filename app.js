// ============================================================
// SUPABASE — Configuration & Auth Integration Layer
// ------------------------------------------------------------
// Gate 3: Auth is live. All other data (students, records, schedule)
// still uses in-memory mock data until Gates 4-7.
//
// LIVE_BACKEND = true when the Supabase client is initialised and
// the project is reachable. Falls back to mock auth when offline.
// ============================================================

const SUPABASE_URL  = 'https://eumhlccvaembpqxcuaqf.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV1bWhsY2N2YWVtYnBxeGN1YXFmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5NTA5ODEsImV4cCI6MjA5NDUyNjk4MX0.spQS7jBkRWLjOZamVAaEPDXkqQHCzWIaqBbldd_-B0E';

// Initialise the client. If the supabase global isn't loaded (e.g. network
// blocked the CDN), SUPABASE_CLIENT stays null and every auth call
// gracefully falls back to the in-memory USERS mock.
let SUPABASE_CLIENT = null;
let LIVE_BACKEND    = false;

try {
  SUPABASE_CLIENT = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,        // picks up magic-link / OAuth tokens in URL
      storageKey: 'vusap-auth-token',  // localStorage key — namespaced so it doesn't
    },                                 // collide with other Supabase apps on the same origin
  });
  LIVE_BACKEND = !!SUPABASE_CLIENT;
} catch(e) {
  console.warn('Supabase client failed to initialise — running in offline mode:', e);
}

// ---------- AUTH HELPERS (Gate 3 live, everything else still mock) ----------

// Sign in. Returns { user, role, error }.
// Live path: supabase.auth.signInWithPassword — Supabase issues a JWT,
//   then we look up the public.users row to get the role + profile data.
// Fallback path: validates against the in-memory USERS map.
async function authSignIn(universityId, password) {
  if (LIVE_BACKEND) {
    try {
      // Accept either a plain university ID (converted to the synthetic
      // <id>@vusap.internal address every demo account uses) OR a real email
      // address typed directly — matches what the "Email / University ID"
      // label already promises, and matches authRequestPasswordReset()'s
      // existing handling of the same ambiguity. Shared via
      // normalizeAuthIdentifier() so both places can't drift apart.
      const email = normalizeAuthIdentifier(universityId);
      const { data, error } = await SUPABASE_CLIENT.auth.signInWithPassword({ email, password });
      if (error) return { user: null, role: null, error: error.message };

      // Fetch the public profile row that carries role + display name.
      const { data: profile, error: pErr } = await SUPABASE_CLIENT
        .from('users')
        .select('*')
        .eq('id', data.user.id)
        .single();

      if (pErr || !profile) {
        // Auth succeeded but profile row missing — sign out and surface the error.
        await SUPABASE_CLIENT.auth.signOut();
        return { user: null, role: null, error: 'Account profile not found. Contact your Administrator.' };
      }

      return {
        user: normalizeProfile(profile, universityId),
        role: profile.role,
        error: null
      };
    } catch(e) {
      console.warn('Live auth failed, falling back to mock:', e);
      // Network error — fall through to mock below.
    }
  }

  // --- Mock fallback ---
  const mock = USERS[universityId];
  if (!mock || mock.password !== password) {
    return { user: null, role: null, error: 'Invalid Email/University ID or password' };
  }
  return { user: { ...mock, id: universityId, staffId: universityId }, role: mock.role, error: null };
}

// Normalize a Supabase profile row into the shape the rest of the app
// expects — same fields whether the user came from live auth or mock USERS.
function normalizeProfile(profile, universityId) {
  const uid = profile.university_id || universityId;
  // `users.program` (per the live schema) may hold a programme `key` (e.g.
  // "cs") or an already-human-readable name depending on how a row was
  // seeded. Every existing screen (badges, filters, info rows) reads a
  // `dept` field expecting the display name — checked both ways against
  // PROGRAMMES (live if loaded, mock default otherwise) so it resolves
  // either way; falls back to the raw value rather than going blank.
  const resolvedDept = (() => {
    if(!profile.program) return null;
    const byKey = PROGRAMMES.find(p => p.key === profile.program);
    if(byKey) return byKey.name;
    const byName = PROGRAMMES.find(p => p.name === profile.program);
    if(byName) return byName.name;
    return profile.program;
  })();
  return {
    ...profile,
    id: uid,            // universityId string used as the primary key throughout the app
    staffId: uid,       // used by logAuditEvent and a few other places
    reg: uid,           // student registration number alias
    name: profile.name,
    role: profile.role,
    email: profile.email,
    facultyKey: profile.faculty_key || null,
    dept: resolvedDept, // see resolvedDept above — Gate 4 needs this for RECORDS.prog on live check-ins
    year: profile.year || null,
    // Sept 2026 handoff, Part 3: 'day' | 'evening' | null — null means no
    // live value yet (existing rows predate this column). Compared against
    // LIVE_SESSION.mode (the specific broadcast's mode) in
    // resolveCheckInOutcome() for the Day/Evening mismatch check — not
    // classes.mode, which can't correctly represent a course offered in
    // both Day and Evening slots.
    mode: profile.mode || null,
    mustChangePassword: profile.must_change_password || false,
    status: profile.status || 'active',
    // Gate 4: the raw public.users PK (== auth.users.id), captured before the
    // override above replaces `id` with the university ID string. This is
    // what `enrollments.student_id` / `attendance.student_id` actually FK
    // against, so anything doing a live Supabase read/write keyed to "this
    // student" needs this, not the university-ID-shaped `id`/`reg` fields.
    supabaseId: profile.id || null,
  };
}

// Shared by authSignIn() and authRequestPasswordReset() so their identical
// "is this a real email or a plain university ID" handling can't drift
// apart from each other.
function normalizeAuthIdentifier(identifier) {
  return identifier.includes('@')
    ? identifier.trim()
    : universityIdToAuthEmail(identifier.trim());
}

// Small, deliberately minimal error-handling helpers — used sparingly (see
// authUpdatePassword() below), not as a blanket replacement for the
// specific, carefully-worded console.warn() calls throughout this file.
function logError(context, error) {
  console.warn(`${context} failed:`, error);
}

function handleDatabaseError(error, context) {
  if (error) {
    logError(context, error);
    return true; // error occurred
  }
  return false; // no error
}

// Dark mode toggle function
function toggleDarkMode() {
  const html = document.documentElement;
  const currentTheme = html.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', newTheme);
  localStorage.setItem('vusap-theme', newTheme);
  showToast(newTheme === 'dark' ? 'Dark mode enabled' : 'Light mode enabled');
}

// Initialize theme from localStorage or system preference
function initializeTheme() {
  const savedTheme = localStorage.getItem('vusap-theme');
  if (savedTheme) {
    document.documentElement.setAttribute('data-theme', savedTheme);
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
}

// Sign out of Supabase session (and clear mock state).
async function authSignOut() {
  if (LIVE_BACKEND) {
    try { await SUPABASE_CLIENT.auth.signOut(); } catch(e) {}
  }
}

// Request a password-reset email.
// Live path: supabase.auth.resetPasswordForEmail — real email sent.
// Fallback: the existing mock flow (passwordResetTarget + in-memory state).
async function authRequestPasswordReset(identifier) {
  if (LIVE_BACKEND) {
    try {
      const email = normalizeAuthIdentifier(identifier);
      const { error } = await SUPABASE_CLIENT.auth.resetPasswordForEmail(email, {
        redirectTo: `${location.origin}${location.pathname}`,
      });
      // Always return success — same "don't reveal account existence" policy.
      return { ok: true, live: true };
    } catch(e) {
      console.warn('Live password reset failed, falling back to mock:', e);
    }
  }
  // Fallback: existing mock logic
  const found = findUserByEmailOrId(identifier);
  passwordResetTarget = found || null;
  return { ok: true, live: false };
}

// Update the signed-in user's password (called from the reset form).
// Live path: supabase.auth.updateUser.
// Fallback: in-memory changePassword().
async function authUpdatePassword(newPassword) {
  if (LIVE_BACKEND) {
    try {
      const { error } = await SUPABASE_CLIENT.auth.updateUser({ password: newPassword });
      if (error) return { ok: false, error: error.message };
      // Also clear the flag in the live profile row — without this, the
      // password itself updates fine but must_change_password stays true
      // forever, so every future login re-triggers this same screen again,
      // no matter how many times the person actually sets a new password.
      if (State.user && State.user.supabaseId) {
        const { error: profileError } = await SUPABASE_CLIENT
          .from('users')
          .update({ must_change_password: false })
          .eq('id', State.user.supabaseId);
        if (!handleDatabaseError(profileError, 'Clearing must_change_password')) {
          State.user.mustChangePassword = false;
        }
      }
      return { ok: true };
    } catch(e) {
      console.warn('Live password update failed, falling back to mock:', e);
    }
  }
  if (State.pendingUserId) {
    changePassword(State.pendingUserId, newPassword);
    return { ok: true };
  }
  return { ok: false, error: 'No user session found' };
}

// Provision a new staff account.
// Live path: supabase.auth.admin requires the service-role key (not safe
// client-side), so we use a Supabase Edge Function "create-user" that
// runs with service-role privileges. Until that function exists we fall
// through to the mock path.
async function authProvisionAccount({ universityId, name, email, role, tempPassword }) {
  // Edge Function path (Gate 5) — left as a clear extension point:
  // if (LIVE_BACKEND) {
  //   const { data, error } = await SUPABASE_CLIENT.functions.invoke('create-user', {
  //     body: { universityId, name, email, role, tempPassword },
  //   });
  //   if (!error) return { id: data.id, tempPassword };
  // }
  // For now, fall through to mock:
  return null; // signals caller to use mock path
}

// Helper: map a university ID to a synthetic email for Supabase Auth.
// e.g. "VU-LEC-101" → "VU-LEC-101@vusap.internal"
function universityIdToAuthEmail(universityId) {
  return `${universityId}@vusap.internal`;
}

// On page load: check if Supabase already has an active session
// (e.g. the user refreshed the page, or followed a reset link).
async function resumeSupabaseSession() {
  if (!SUPABASE_CLIENT) return;
  try {
    const { data: { session } } = await SUPABASE_CLIENT.auth.getSession();
    if (!session) return;

    // Check if this is a password-reset redirect (hash contains type=recovery).
    const hash = window.location.hash;
    if (hash.includes('type=recovery') || hash.includes('type=signup')) {
      // Let the reset flow handle it — renderApp() will show the login screen
      // and the URL token will allow updateUser() to work.
      return;
    }

    // Existing session — fetch profile and boot straight into the app.
    const { data: profile } = await SUPABASE_CLIENT
      .from('users')
      .select('*')
      .eq('id', session.user.id)
      .single();

    if (profile) {
      const normalized = normalizeProfile(profile, profile.university_id || session.user.email);
      State.role = normalized.role;
      State.user = normalized;
      document.getElementById('app').setAttribute('data-role', normalized.role);
      loadEnrollmentsFromSupabase(); // Gate 4 — see handleLogin() for the same fire-and-forget call
      loadNotificationsFromSupabase();
      loadSentNotificationsFromSupabase();
      // Same gate handleLogin() enforces on a fresh sign-in — a resumed
      // session (page reload, or an already-open tab) must not be able to
      // skip setting a real password just by not going through login again.
      const mustChange = normalized.mustChangePassword ?? normalized.must_change_password ?? false;
      if(mustChange){
        renderForcedPasswordChange();
      } else {
        boot();
      }
    }
  } catch(e) {
    console.warn('Session resume failed:', e);
  }
}

// ------------------------------------------------------------
// LIVE QR SESSION SYNC (Gate 3 part 2) — broadcasts the Lecturer's
// rotating token via the dedicated `live_qr_sessions` table so the
// Student's device can pick it up cross-device via Supabase Realtime.
// Additive: the existing in-memory LIVE_SESSION ticker keeps working
// exactly as before even when LIVE_BACKEND is false.
// ------------------------------------------------------------

// Lecturer side: mark any other still-active rows for this course inactive
// before starting a fresh session, so a Lecturer restarting without properly
// ending the last session never leaves two "active" rows for the same course
// (which would otherwise let a Student's device latch onto the stale one).
async function liveDeactivateOtherSessions(courseCode){
  if(!LIVE_BACKEND) return;
  try {
    // A Lecturer can only genuinely teach one live session at a time — if an
    // earlier session for a DIFFERENT course was never explicitly ended
    // (e.g. testing/navigating away instead of clicking "End Session Now"),
    // it stayed active:true in the database forever. A Student's device
    // discovering active sessions by looping through their own enrolled
    // courses could then lock onto that stale old session instead of the
    // Lecturer's actually-current one, showing a different course as "Live"
    // on each side. Deactivating only same-course-code duplicates (the
    // original behavior) didn't catch this — so this now also cleans up
    // any other active session across every course this lecturer teaches.
    const ownCourseCodes = COURSES.filter(c => c.lecturer === State.user?.name).map(c => c.code);
    const codesToClear = [...new Set([courseCode, ...ownCourseCodes])];
    const { error } = await SUPABASE_CLIENT
      .from('live_qr_sessions')
      .update({ active: false, updated_at: new Date().toISOString() })
      .in('course_code', codesToClear)
      .eq('active', true);
    if(error) console.warn('liveDeactivateOtherSessions failed:', error);
  } catch(e){
    console.warn('liveDeactivateOtherSessions error:', e);
  }
}

// Lecturer side: create/update the broadcast row to match local LIVE_SESSION state.
async function liveWriteSession(){
  if(!LIVE_BACKEND) return;
  const payload = {
    course_code: LIVE_SESSION.courseCode,
    course_name: LIVE_SESSION.courseName,
    room: LIVE_SESSION.room,
    mode: LIVE_SESSION.mode || null,
    // Gate 5, live_qr_sessions RLS: the table previously had no column
    // identifying which lecturer owns a broadcast at all, so "only the
    // owning lecturer can update/end their session" couldn't be enforced
    // at the database level. This is that column.
    lecturer_id: State.user?.supabaseId || null,
    pin: LIVE_SESSION.pin,
    token: LIVE_SESSION.token,
    active: LIVE_SESSION.active,
    window_seconds: LIVE_SESSION.windowSeconds,
    token_rotate_seconds: LIVE_SESSION.tokenRotateSeconds,
    updated_at: new Date().toISOString(),
  };
  // started_at is deliberately NOT sent from this client's clock. It's only
  // ever set once, by the database's own `default now()` on the initial
  // insert, and never touched again on later updates (token rotations).
  // Comparing this against attendance.marked_at (also server-assigned — see
  // liveWriteAttendance()) means the Lecturer's device and a Student's
  // device never need to agree on the time, since neither of their clocks
  // is used at all. A prior version of this sent LIVE_SESSION.startedAt
  // from the Lecturer's own clock, which broke the live roster whenever a
  // Student's device clock had drifted even slightly behind.
  try {
    if(LIVE_SESSION.liveSessionId){
      const { error } = await SUPABASE_CLIENT
        .from('live_qr_sessions')
        .update(payload)
        .eq('id', LIVE_SESSION.liveSessionId);
      if(error) console.warn('liveWriteSession update failed:', error);
    } else {
      const { data, error } = await SUPABASE_CLIENT
        .from('live_qr_sessions')
        .insert(payload)
        .select()
        .single();
      if(error) console.warn('liveWriteSession insert failed:', error);
      else if(data){
        LIVE_SESSION.liveSessionId = data.id;
        LIVE_SESSION.serverStartedAt = data.started_at; // authoritative — from the DB's own clock
      }
    }
  } catch(e){
    console.warn('liveWriteSession error:', e);
  }
  updateDebugPanel();
}

// Student side: find the currently active broadcast row for a given course code.
async function liveFindActiveSession(courseCode){
  if(!LIVE_BACKEND) return null;
  try {
    const { data, error } = await SUPABASE_CLIENT
      .from('live_qr_sessions')
      .select('*')
      .eq('course_code', courseCode)
      .eq('active', true)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if(error){ console.warn('liveFindActiveSession error:', error); return null; }
    return data;
  } catch(e){
    console.warn('liveFindActiveSession failed:', e);
    return null;
  }
}

// Apply a broadcast row (from initial fetch or a Realtime update) onto local LIVE_SESSION.
function applyLiveSessionRow(row){
  if(!row) return;
  LIVE_SESSION.liveSessionId = row.id;
  LIVE_SESSION.courseCode = row.course_code;
  LIVE_SESSION.courseName = row.course_name;
  LIVE_SESSION.room = row.room;
  LIVE_SESSION.mode = row.mode || null; // see liveWriteSession() — the actual source of truth for mode, now stored on the row itself rather than only ever known on the Lecturer's own device
  LIVE_SESSION.pin = row.pin;
  LIVE_SESSION.token = row.token;
  LIVE_SESSION.active = row.active;
  LIVE_SESSION.startedAt = new Date(row.started_at).getTime();
  LIVE_SESSION.serverStartedAt = row.started_at; // authoritative — see liveWriteSession()
  LIVE_SESSION.windowSeconds = row.window_seconds;
  LIVE_SESSION.tokenRotateSeconds = row.token_rotate_seconds;
}

let liveSessionUpdatesUnsubscribe = null;
let studentLiveSyncDoneForThisVisit = false;

// Subscribe to Realtime changes for a course's live broadcast row(s).
// Filtering by course_code (not a fixed session id) is deliberate: when the
// Lecturer starts a NEW session, that's a fresh INSERT with a new id, not an
// UPDATE to the old row. A subscription pinned to the old id would never
// hear about it. Listening on the whole course instead means any INSERT or
// UPDATE for this course — new session or a token rotation — re-syncs us.
function subscribeToLiveSession(courseCode){
  if(!LIVE_BACKEND) return;
  if(liveSessionUpdatesUnsubscribe){
    liveSessionUpdatesUnsubscribe();
    liveSessionUpdatesUnsubscribe = null;
  }
  const channel = SUPABASE_CLIENT
    .channel('live-qr-course-' + courseCode)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'live_qr_sessions',
      filter: `course_code=eq.${courseCode}`,
    }, (payload) => {
      const row = payload.new;
      if(!row) return;
      // Only adopt a row if it's the currently active one, or it's the
      // session we're already tracking (so we still see it flip to ended).
      if(row.active || row.id === LIVE_SESSION.liveSessionId){
        applyLiveSessionRow(row);
        updateDebugPanel();
      }
    })
    .subscribe();

  liveSessionUpdatesUnsubscribe = () => {
    SUPABASE_CLIENT.removeChannel(channel);
    liveSessionUpdatesUnsubscribe = null;
  };
  updateDebugPanel();
}

// Mirrors the Student side's active-session discovery, but for the
// Lecturer's Dashboard tile: LIVE_SESSION.active defaults to true even
// before any real session exists (a mock-mode convenience), so this checks
// liveSessionId too — that field only ever gets set once a broadcast row
// is actually confirmed, either by starting one or by discovering an
// existing one here. Runs every time the Lecturer visits the Dashboard, so
// the tile correctly says "Current Session" if one's already running
// (e.g. they navigated away and back, or reloaded) instead of always
// defaulting to "Start Live Session" regardless of reality.
// (Restored — this was dropped from a prior build; see the navigate() hook
// comment for how the regression was found.)
async function checkLecturerActiveSession(){
  if(!LIVE_BACKEND) return;
  try {
    // LIVE_SESSION.courseCode only reflects the Lecturer's real course once
    // a session has actually been applied THIS page load (applyLiveSessionRow()
    // / startSessionForLecture()) — right after a reload it's back to the
    // module's hardcoded default ("CSC3103"), so checking only that one course
    // silently missed a genuinely-running session on any other course, making
    // the Dashboard tile (and everything gated on it, like the roster below)
    // look like nothing was running. Search every course this Lecturer
    // actually teaches instead — same discovery pattern as the Student
    // side's startStudentLiveSessionSync().
    let row = null, resumedCode = null;
    for(const code of coursesForLecturer().map(c => c.code)){
      row = await liveFindActiveSession(code);
      if(row){ resumedCode = code; break; }
    }
    if(row){
      applyLiveSessionRow(row);
      subscribeToLiveSession(resumedCode);
      // applyLiveSessionRow() has no scheduling `sessions` row id to give us
      // (live_qr_sessions doesn't carry one) — without re-resolving it here,
      // updateLiveRoster()'s guard on LIVE_SESSION.schedulingSessionId stays
      // blocked forever after a rediscovery like this, even though a session
      // is genuinely running. Same idempotent select-then-insert
      // startSessionForLecture() already relies on for the same field.
      liveEnsureSchedulingSession(resumedCode).then(id => {
        LIVE_SESSION.schedulingSessionId = id;
        updateDebugPanel();
      });
      refreshScreenContentOnly(); // hook-free — see its own comment for why not rerenderCurrentScreen()
    } else if(LIVE_SESSION.active || LIVE_SESSION.liveSessionId){
      // This is the fix for a real bug found in testing: endSession() sets
      // LIVE_SESSION.active = false and writes that to the database, but
      // never clears liveSessionId — so within the same browser session
      // (no reload), the client kept believing a session was still active
      // even after the database correctly showed nothing running. Because
      // this function previously only ever ADDED state when it found an
      // active broadcast, it never corrected that staleness — discovering
      // "nothing is active" needs to actively clear stale local state, not
      // just silently do nothing. This caused "Start Live Session" to skip
      // the lecture picker entirely and jump straight into a stale session.
      LIVE_SESSION.active = false;
      LIVE_SESSION.liveSessionId = null;
      LIVE_SESSION.serverStartedAt = null;
      LIVE_SESSION.mode = null;
    }
  } catch(e){
    console.warn('checkLecturerActiveSession error:', e);
  }
}

// Student side: discover the active session across the student's enrolled
// courses, apply it, and open the Realtime subscription. Guarded so it
// only runs once per visit to the Check-In screen (avoids re-render loops).
async function startStudentLiveSessionSync(){
  if(!LIVE_BACKEND || studentLiveSyncDoneForThisVisit) return;
  studentLiveSyncDoneForThisVisit = true;
  for(const c of STUDENT_COURSES){
    const row = await liveFindActiveSession(c.code);
    if(row){
      applyLiveSessionRow(row);
      subscribeToLiveSession(c.code);
      await restoreCheckedInStateForBroadcast(row.id);
      return;
    }
  }
  updateDebugPanel();
}

// hasCheckedInToday only ever gets set true locally, inside completeCheckIn()
// — nothing had ever restored it from the database, so a student who
// genuinely already checked in (in an earlier session, or just before a
// reload) would see the QR scanner again instead of their "You're checked
// in" confirmation, purely because that flag lives only in memory. This
// runs every time the active broadcast is (re)discovered, so it self-heals
// on reload without needing the student to rescan. (Restored here — this
// was dropped from a prior build that started from a zip predating this fix.)
async function restoreCheckedInStateForBroadcast(broadcastId){
  if(!LIVE_BACKEND || !State.user || !State.user.supabaseId || !broadcastId) return;
  try {
    const { data, error } = await SUPABASE_CLIENT
      .from('attendance')
      .select('id')
      .eq('live_broadcast_id', broadcastId)
      .eq('student_id', State.user.supabaseId)
      .maybeSingle();
    if(error){ console.warn('restoreCheckedInStateForBroadcast failed:', error); return; }
    if(data){
      State.hasCheckedInToday = true;
      refreshScreenContentOnly(); // hook-free — see its own comment for why not rerenderCurrentScreen()
    }
  } catch(e){
    console.warn('restoreCheckedInStateForBroadcast error:', e);
  }
}

// Reset the sync guard + tear down the subscription when the Student leaves
// the Check-In screen, so returning to it re-discovers the live session fresh.
function resetStudentLiveSync(){
  studentLiveSyncDoneForThisVisit = false;
  if(liveSessionUpdatesUnsubscribe){
    liveSessionUpdatesUnsubscribe();
    liveSessionUpdatesUnsubscribe = null;
  }
}

// ------------------------------------------------------------
// SCHEDULING SESSIONS & ATTENDANCE — live write (Gate 4, part 3).
// `sessions` here is the scheduling table (id, class_id, teacher_id,
// topic, date) — a durable "this lecture happened" record. It is
// deliberately separate from `live_qr_sessions` above, which is only the
// ephemeral rotating QR/PIN broadcast; don't conflate the two (see the
// Gate 4 handoff brief's gotcha #6 — a table's real columns were checked
// against information_schema, not assumed, before this was written).
// `attendance` rows (session_id, student_id, status, marked_at) hang off
// the scheduling row created/reused here. Both are additive alongside the
// existing local RECORDS/State.hasCheckedInToday behaviour — any failure
// just leaves the local check-in exactly as it already worked before Gate 4.
// ------------------------------------------------------------

// Find (or create) today's scheduling `sessions` row for a course code.
// Select-then-insert so restarting the QR/PIN broadcast for the same
// course later the same day reuses one scheduling row instead of minting
// a fresh one per click — mirrors liveDeactivateOtherSessions()'s intent
// for live_qr_sessions, applied to the durable table instead.
async function liveEnsureSchedulingSession(courseCode){
  if(!LIVE_BACKEND) return null;
  try {
    const { data: classRow, error: cErr } = await SUPABASE_CLIENT
      .from('classes')
      .select('id, teacher_id')
      .eq('code', courseCode)
      .maybeSingle();
    if(cErr || !classRow){
      // No seeded `classes` row for this course code — stay local-only for
      // scheduling/attendance rather than guessing at a class_id.
      if(cErr) console.warn('liveEnsureSchedulingSession: classes lookup failed:', cErr);
      return null;
    }

    const today = new Date().toISOString().slice(0,10); // `date` column — date-only, no time component

    const { data: existing, error: sErr } = await SUPABASE_CLIENT
      .from('sessions')
      .select('id')
      .eq('class_id', classRow.id)
      .eq('date', today)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if(sErr) console.warn('liveEnsureSchedulingSession: sessions lookup failed:', sErr);
    if(existing) return existing.id;

    const { data: inserted, error: iErr } = await SUPABASE_CLIENT
      .from('sessions')
      .insert({
        class_id: classRow.id,
        teacher_id: classRow.teacher_id,
        topic: LIVE_SESSION.courseName,
        date: today,
      })
      .select()
      .single();
    if(iErr || !inserted){
      console.warn('liveEnsureSchedulingSession: sessions insert failed:', iErr);
      return null;
    }
    return inserted.id;
  } catch(e){
    console.warn('liveEnsureSchedulingSession error:', e);
    return null;
  }
}

// Write the live `attendance` row for whichever student just checked in
// (QR or PIN — completeCheckIn() is the single funnel for both). Additive:
// called after the local RECORDS/State update already succeeded, and never
// reverts it on failure.
// Persistent per-browser device identifier (Gate 4, fraud detection). Not a
// true hardware fingerprint — that's not achievable from a web app without
// invasive APIs — but a UUID generated once and kept in localStorage is the
// standard, privacy-reasonable proxy: stable across sessions on the SAME
// device/browser, different across different ones, which is exactly the
// "same device checking in two different students" signal this needs.
function getDeviceId(){
  let id;
  try { id = localStorage.getItem('vusap-device-id'); } catch(e){ /* storage unavailable */ }
  if(!id){
    const rand = (window.crypto && crypto.randomUUID) ? crypto.randomUUID().slice(0,8) : Math.random().toString(36).slice(2,10);
    id = 'DVC-' + rand.toUpperCase();
    try { localStorage.setItem('vusap-device-id', id); } catch(e){ /* falls back to a session-only id */ }
  }
  return id;
}

async function liveWriteAttendance(){
  if(!LIVE_BACKEND || !State.user || !State.user.supabaseId) return;
  try {
    let sessionId = LIVE_SESSION.schedulingSessionId;
    if(!sessionId){
      // startSessionForLecture() already fires this once per broadcast (fire-and-
      // forget); re-resolving here (idempotent select-then-insert) covers
      // the rare race where a check-in lands before that resolves.
      sessionId = await liveEnsureSchedulingSession(LIVE_SESSION.courseCode);
      LIVE_SESSION.schedulingSessionId = sessionId;
    }
    if(!sessionId) return; // no live classes/sessions row to attach to — stays local-only

    const deviceId = getDeviceId();

    // marked_at is deliberately NOT sent from this client's clock — left to
    // the database's own `default now()` and read back from the insert
    // response. This device's clock (a student's phone) never has to agree
    // with the Lecturer's device or any other student's device for the live
    // roster/count and fraud-window checks to line up correctly.
    const { data, error } = await SUPABASE_CLIENT
      .from('attendance')
      .insert({
        session_id: sessionId,
        // Sept 2026 handoff, Part 1: a stable link to the exact broadcast
        // this check-in belongs to (not just the reused-per-day scheduling
        // session above) — see the unique constraint change in the
        // accompanying migration and resolveCheckInOutcome()'s use of this
        // same column for duplicate/mismatch detection.
        live_broadcast_id: LIVE_SESSION.liveSessionId || null,
        student_id: State.user.supabaseId,
        student_name: State.user.name || null,
        status: 'present',
        device_id: deviceId,
      })
      .select()
      .single();
    if(error){ console.warn('liveWriteAttendance insert failed:', error); return; }
    const markedAt = data?.marked_at || new Date().toISOString();
    updateDebugPanel();

    // Fraud detection only runs after a confirmed successful write, using
    // the device id and server-assigned timestamp that was actually just recorded.
    checkFraudSignals(sessionId, deviceId, markedAt);
  } catch(e){
    console.warn('liveWriteAttendance error:', e);
  }
}

// ------------------------------------------------------------
// FRAUD DETECTION (Gate 4, part 6). Runs two checks, both driven by the
// existing FRAUD_THRESHOLDS admin settings (previously decorative — this is
// what actually wires them up):
//  1. Same device used to check in two different students within
//     sharedDeviceWindowMinutes.
//  2. Check-in landing after the session's window + lateWindowAfterClose
//     grace period.
// Deliberately NOT implemented: "device fingerprint mismatch from
// enrollment" (one of the three original mock reasons) — there's no
// concept of a registered enrollment device anywhere in this app, and
// inventing one is a separate, bigger feature than "wire up the two
// thresholds that already exist."
// ------------------------------------------------------------

async function checkFraudSignals(sessionId, deviceId, markedAtIso){
  try {
    const windowMinutes = FRAUD_THRESHOLDS.sharedDeviceWindowMinutes || 0;
    if(windowMinutes > 0){
      const { data: others, error } = await SUPABASE_CLIENT
        .from('attendance')
        .select('student_id, marked_at')
        .eq('session_id', sessionId)
        .eq('device_id', deviceId)
        .neq('student_id', State.user.supabaseId)
        .order('marked_at', { ascending: false })
        .limit(5);
      if(!error && others && others.length){
        const now = new Date(markedAtIso).getTime();
        const windowMs = windowMinutes * 60 * 1000;
        const withinWindow = others.some(o => Math.abs(now - new Date(o.marked_at).getTime()) <= windowMs);
        if(withinWindow){
          logSuspicion(
            State.user?.name || 'Unknown student',
            `Same device used for ${others.length + 1} students within ${windowMinutes} minutes`,
            'high',
            LIVE_SESSION.courseCode,
            deviceId
          );
        }
      }
    }

    const graceMs = (FRAUD_THRESHOLDS.lateWindowAfterClose || 0) * 60 * 1000;
    const sessionStartMs = LIVE_SESSION.serverStartedAt ? new Date(LIVE_SESSION.serverStartedAt).getTime() : LIVE_SESSION.startedAt;
    const sessionCloseMs = sessionStartMs + (LIVE_SESSION.windowSeconds * 1000);
    if(new Date(markedAtIso).getTime() > sessionCloseMs + graceMs){
      logSuspicion(
        State.user?.name || 'Unknown student',
        'Check-in attempted after session window closed',
        'medium',
        LIVE_SESSION.courseCode,
        deviceId
      );
    }
  } catch(e){
    console.warn('checkFraudSignals error:', e);
  }
}

function logSuspicion(student, reason, severity, course, deviceId){
  SUSPICION_LOG.unshift({
    id: suspicionNextId++,
    student, reason, severity, course,
    date: new Date().toISOString().replace('T',' ').slice(0,16),
    deviceId,
  });
  liveWriteSuspicion(student, reason, severity, course, deviceId); // fire-and-forget — local log above already succeeded either way
  if(severity === 'high' && FRAUD_THRESHOLDS.autoEscalateHighSeverity){
    // Reuses the Gate 4 notifications system built earlier — no separate
    // escalation channel needed. Broadcast to the Registrar role broadly
    // rather than trying to resolve "the registrar for this student's
    // faculty," since there's no clean resolver for that wired up yet.
    pushNotification({
      recipientRole: 'registrar', recipientId: null, type: 'fraudFlagged',
      title: 'High-severity fraud flag', body: `${student}: ${reason}`,
      from: 'System', fromId: 'system',
    });
  }
}

async function liveWriteSuspicion(student, reason, severity, course, deviceId){
  if(!LIVE_BACKEND) return;
  try {
    const { error } = await SUPABASE_CLIENT
      .from('fraud_logs')
      .insert({ student, reason, severity, course, device_id: deviceId });
    if(error) console.warn('liveWriteSuspicion failed:', error);
  } catch(e){
    console.warn('liveWriteSuspicion error:', e);
  }
}

// ------------------------------------------------------------
// DUPLICATE / MISMATCH DETECTION (Sept 2026 handoff, Part 2). Runs BEFORE
// any attendance row is written — completeCheckIn() awaits this and only
// proceeds with the local "you're checked in" state and the real insert if
// it resolves to 'proceed'. Checks run in the brief's stated order, each
// one only as expensive as it needs to be:
//   1. A row already exists for THIS exact broadcast → 'duplicate' (block,
//      same effect the old unique constraint gave for free, just with a
//      clean app-level response instead of a raw DB conflict).
//   2. A row already exists for this course TODAY under a DIFFERENT
//      broadcast → 'appeal' (a second live session for the same course the
//      same day — reuses `sessions` rows being deliberately deduped by
//      class_id+date, exactly the design liveEnsureSchedulingSession()
//      already relies on).
//   3. The scanned class doesn't match the student's own programme, or
//      doesn't match their Day/Evening mode → 'appeal'.
// Local-only (mock) mode, or a live account with no Supabase identity,
// always resolves to 'proceed' immediately — there is no live `attendance`
// table to check against, so this can't (and shouldn't) block anything.
// Fails open on any live error, same tolerant pattern as every other live
// read in this app — a broken check here must never be able to prevent a
// real check-in.
// ------------------------------------------------------------
async function resolveCheckInOutcome(){
  if(!LIVE_BACKEND || !State.user || !State.user.supabaseId){
    return { outcome: 'proceed' };
  }
  const courseCode = LIVE_SESSION.courseCode;
  const courseName = LIVE_SESSION.courseName;
  const broadcastId = LIVE_SESSION.liveSessionId;

  try {
    // Step 1 — already checked in to this exact broadcast.
    if(broadcastId){
      const { data: dup, error: e1 } = await SUPABASE_CLIENT
        .from('attendance')
        .select('id')
        .eq('live_broadcast_id', broadcastId)
        .eq('student_id', State.user.supabaseId)
        .maybeSingle();
      if(e1) console.warn('resolveCheckInOutcome: same-broadcast lookup failed:', e1);
      if(dup) return { outcome: 'duplicate' };
    }

    // Step 2 — already checked in to a different broadcast, same course/day.
    // sessionId is the scheduling `sessions` row, reused across every
    // restart of this course today — see liveEnsureSchedulingSession(), and
    // resolve it the same lazy way liveWriteAttendance() does if a Realtime
    // sync hasn't already filled it in.
    let sessionId = LIVE_SESSION.schedulingSessionId;
    if(!sessionId){
      sessionId = await liveEnsureSchedulingSession(courseCode);
      LIVE_SESSION.schedulingSessionId = sessionId;
    }
    if(sessionId){
      const { data: sameDay, error: e2 } = await SUPABASE_CLIENT
        .from('attendance')
        .select('id, live_broadcast_id')
        .eq('session_id', sessionId)
        .eq('student_id', State.user.supabaseId)
        .order('marked_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if(e2) console.warn('resolveCheckInOutcome: same-day lookup failed:', e2);
      if(sameDay && sameDay.live_broadcast_id && sameDay.live_broadcast_id !== broadcastId){
        return {
          outcome: 'appeal',
          reason: `Checked into a second session for ${courseName || courseCode} today — please explain.`,
        };
      }
    }

    // Step 3 — scanned class doesn't match the student's own programme or
    // Day/Evening mode (Part 3). The mode comparison is against
    // LIVE_SESSION.mode (this specific broadcast's mode, now stored on
    // live_qr_sessions itself) rather than classes.mode — a single,
    // course-level mode value can't correctly represent a course that's
    // genuinely offered in both Day and Evening slots (e.g. CSC3103 has
    // both), so comparing against the course's static value would flag a
    // legitimate check-in as a mismatch depending purely on which of that
    // course's own sessions happened to set classes.mode last. Programme
    // is still a valid single-value-per-course check — a course only ever
    // belongs to one programme — so that half still queries classes.
    // Both sides nullable: null means "no restriction," so a class/account
    // that predates this column never blocks anyone. Missing student-side
    // data (no dept/mode yet) is treated the same way: skip that half of
    // the check rather than blocking a legitimate check-in over incomplete
    // profile data.
    const { data: classRow, error: e3 } = await SUPABASE_CLIENT
      .from('classes')
      .select('id, programmes(name)')
      .eq('code', courseCode)
      .maybeSingle();
    if(e3) console.warn('resolveCheckInOutcome: classes lookup failed:', e3);
    const modeMismatch = LIVE_SESSION.mode && State.user.mode
      && LIVE_SESSION.mode !== State.user.mode;
    const programmeMismatch = classRow?.programmes?.name && State.user.dept
      && classRow.programmes.name !== State.user.dept;
    if(programmeMismatch || modeMismatch){
      return {
        outcome: 'appeal',
        reason: modeMismatch
          ? `Checked into ${LIVE_SESSION.mode === 'evening' ? 'an' : 'a'} ${LIVE_SESSION.mode} session for ${courseName || courseCode} but registered as ${State.user.mode} — please explain.`
          : `Checked into a session outside your registered programme (${courseName || courseCode}) — please explain.`,
      };
    }

    return { outcome: 'proceed' };
  } catch(e){
    console.warn('resolveCheckInOutcome error, proceeding local-only:', e);
    return { outcome: 'proceed' };
  }
}

async function loadSuspicionLogFromSupabase(){
  if(!LIVE_BACKEND) return;
  try {
    const { data: rows, error } = await SUPABASE_CLIENT
      .from('fraud_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if(error){ console.warn('Fraud log fetch failed, keeping mock SUSPICION_LOG:', error); return; }
    if(!rows || rows.length === 0) return; // no live rows yet — keep mock so the list isn't empty

    const fetched = rows.map(r => ({
      id: r.id,
      student: r.student,
      reason: r.reason,
      severity: r.severity,
      course: r.course,
      date: r.created_at ? r.created_at.replace('T',' ').slice(0,16) : '',
      deviceId: r.device_id,
    }));

    SUSPICION_LOG.length = 0;
    SUSPICION_LOG.push(...fetched);
    refreshScreenContentOnly(); // hook-free — see its own comment for why not rerenderCurrentScreen()
  } catch(e){
    console.warn('loadSuspicionLogFromSupabase error, keeping mock SUSPICION_LOG:', e);
  }
}

// Lecturer's "Checked In" tile on the Start Session screen (Gate 4). Polled
// rather than a Realtime subscription: simpler and lower-risk than adding a
// second channel alongside the live_qr_sessions one, and "optionally...
// Realtime for true cross-device roster updates" was explicitly left as a
// judgment call in the handoff brief. Polling every few ticker seconds is
// plenty for a room-sized class. No-ops (leaves the tile as last drawn)
// until a scheduling session id exists.

// Server-authoritative boundary for "since this live broadcast started" —
// never the Lecturer's own device clock. Falls back to the client value
// only if a server timestamp genuinely isn't available yet (e.g. mock mode).
// No longer used by updateLiveCheckinCount()/updateLiveRoster() as of the
// Sept 2026 handoff's Part 1 (they filter by live_broadcast_id instead,
// which doesn't reset on a reload the way this time boundary did) — left
// in place since it's still a correct, reusable primitive if something
// else needs a "since broadcast start" cutoff later.
function liveSessionStartBoundary(){
  return LIVE_SESSION.serverStartedAt
    ? new Date(LIVE_SESSION.serverStartedAt).toISOString()
    : new Date(LIVE_SESSION.startedAt).toISOString();
}

async function updateLiveCheckinCount(){
  const el = document.getElementById('liveCheckinCount');
  if(!el || !LIVE_BACKEND || !LIVE_SESSION.schedulingSessionId || !LIVE_SESSION.liveSessionId) return;
  try {
    // sessions rows are reused across every "Start Session" restart on the
    // same day for the same course (liveEnsureSchedulingSession() dedupes by
    // class_id+date on purpose, to avoid minting a fresh scheduling row per
    // click) — so filtering by session_id alone would count check-ins from
    // EARLIER restarts today too. Sept 2026 handoff, Part 1: filtering by
    // live_broadcast_id (a stable id for THIS exact broadcast) replaces the
    // old marked_at time-window heuristic, which broke the moment the
    // Lecturer's own device reloaded — a fresh page load has no memory of
    // when the broadcast started, so the "since this broadcast's start"
    // boundary silently reset to "now" and dropped every earlier check-in.
    const { count, error } = await SUPABASE_CLIENT
      .from('attendance')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', LIVE_SESSION.schedulingSessionId)
      .eq('live_broadcast_id', LIVE_SESSION.liveSessionId);
    if(error){ console.warn('updateLiveCheckinCount failed:', error); return; }
    if(typeof count === 'number') el.textContent = String(count);
  } catch(e){
    console.warn('updateLiveCheckinCount error:', e);
  }
}

// Live roster of who's checked in, newest first — reuses student_name
// denormalized onto the attendance row at check-in time (see
// liveWriteAttendance()), so this needs only the "Staff read all
// attendance" policy already in place, not any broader access to `users`.
async function updateLiveRoster(){
  const el = document.getElementById('liveRosterList');
  if(!el || !LIVE_BACKEND || !LIVE_SESSION.schedulingSessionId || !LIVE_SESSION.liveSessionId) return;
  try {
    // See updateLiveCheckinCount() above — live_broadcast_id replaces the
    // old marked_at time-window filter for the same reload-resets-the-roster reason.
    const { data, error } = await SUPABASE_CLIENT
      .from('attendance')
      .select('student_name, marked_at')
      .eq('session_id', LIVE_SESSION.schedulingSessionId)
      .eq('live_broadcast_id', LIVE_SESSION.liveSessionId)
      .order('marked_at', { ascending: false })
      .limit(50);
    if(error){ console.warn('updateLiveRoster failed:', error); return; }
    if(!data) return;
    if(data.length === 0){
      el.innerHTML = `<div class="empty-state-sm">No check-ins yet</div>`;
      return;
    }
    el.innerHTML = data.map(r => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line);">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="width:6px;height:6px;border-radius:50%;background:var(--present);flex-shrink:0;"></span>
          <div style="font-size:13px;font-weight:600;">${r.student_name || 'Unknown student'}</div>
        </div>
        <div style="font-size:11px;color:var(--ink-faint);">${new Date(r.marked_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</div>
      </div>
    `).join('');
  } catch(e){
    console.warn('updateLiveRoster error:', e);
  }
}

// ------------------------------------------------------------
// FACULTIES & PROGRAMMES — live read (Gate 4, part 1)
// Read-only reference data. On success, replaces the mock FACULTIES/
// PROGRAMMES arrays in place so every existing screen that reads them
// keeps working unchanged. On any failure (offline, table missing, RLS
// block) it silently keeps the mock defaults — same fallback pattern as
// Auth in Gate 3.
// ------------------------------------------------------------
async function loadFacultiesAndProgrammesFromSupabase(){
  if(!LIVE_BACKEND) return;
  try {
    const { data: facultyRows, error: fErr } = await SUPABASE_CLIENT
      .from('faculties')
      .select('*')
      .order('name');
    const { data: programmeRows, error: pErr } = await SUPABASE_CLIENT
      .from('programmes')
      .select('*, faculties(key, name)')
      .order('name');

    if(fErr || pErr || !facultyRows || !programmeRows || facultyRows.length === 0 || programmeRows.length === 0){
      // A successful-but-empty result (an unseeded `faculties`/`programmes`
      // table) is not safe to treat as authoritative: it would null out
      // every programme's facultyKey via the `faculties(key, name)` embed,
      // which silently empties scopedCourses() for every Registrar even
      // though courses genuinely exist. Keep the mock defaults, same as
      // an outright fetch error.
      console.warn('Faculties/Programmes fetch returned nothing usable, keeping mock data:', fErr || pErr);
      return;
    }

    const newProgrammes = programmeRows.map(p => ({
      facultyKey: p.faculties ? p.faculties.key : null,
      facultyName: p.faculties ? p.faculties.name : null,
      key: p.key,
      name: p.name,
      codePrefix: p.code_prefix,
    }));

    const newFaculties = facultyRows.map(f => ({
      key: f.key,
      name: f.name,
      programmes: newProgrammes.filter(p => p.facultyKey === f.key).map(p => p.key),
    }));

    FACULTIES = newFaculties;
    PROGRAMMES = newProgrammes;

    // COURSES[].programmeKey was resolved once, at module load, against the
    // mock PROGRAMMES array (see buildInitialCourseCatalog()). Swapping in
    // the live PROGRAMMES above leaves those keys pointing at nothing
    // whenever the live `programmes.key` values don't match the mock's —
    // which silently empties scopedCourses() for every faculty (the
    // Course dropdown in Create/Edit Session goes blank, since its find()
    // never matches). Re-resolve each course's programmeKey by programme
    // *name* — which is stable across mock/live — against the PROGRAMMES
    // set that's actually live now.
    COURSES.forEach(c => {
      const prog = PROGRAMMES.find(p => p.name === c.programme);
      if(prog) c.programmeKey = prog.key;
    });
  } catch(e){
    console.warn('loadFacultiesAndProgrammesFromSupabase error, keeping mock data:', e);
  }
}

// ------------------------------------------------------------
// ENROLLMENTS — live read (Gate 4, part 2). Replaces the mock
// STUDENT_COURSES with the signed-in student's real `enrollments` ->
// `classes` rows. Additive/fallback, same shape as Faculties/Programmes
// above: on any failure (offline, table empty, RLS block, or the signed-in
// account has no live Supabase identity — e.g. a mock-only login) it
// silently keeps whatever STUDENT_COURSES already had. Mutates the array
// in place (STUDENT_COURSES is declared `const`, but every screen reads
// it by reference) rather than reassigning the binding.
// ------------------------------------------------------------
const STUDENT_COURSE_COLORS = ['#3b82f6', '#8b5cf6', '#0f766e', '#d97706', '#dc2626', '#0891b2', '#c026d3', '#65a30d'];

async function loadTimetableFromSupabase(){
  if(!LIVE_BACKEND) return;
  try {
    const { data: rows, error } = await SUPABASE_CLIENT
      .from('timetable_slots')
      .select('*, classes(code, name, teacher_id, programmes(name))')
      .order('day_of_week, start_time');

    if(error){
      console.warn('Timetable fetch failed, keeping mock SCHEDULE:', error);
      return;
    }
    if(!rows || rows.length === 0){
      // Table reachable but no slots yet — keep mock data
      return;
    }

    // Batch-resolve lecturer names from teacher_ids. Read off the slot's
    // OWN teacher_id, not classes.teacher_id — a lecturer is now assigned
    // per session (see migrate-per-session-lecturer.sql), so two sessions
    // of the same course can genuinely have different teachers.
    const teacherIds = [...new Set(rows.map(r => r.teacher_id).filter(Boolean))];
    let teacherNames = {};
    if(teacherIds.length){
      try {
        const { data: teacherRows } = await SUPABASE_CLIENT
          .from('users')
          .select('id, name')
          .in('id', teacherIds);
        (teacherRows || []).forEach(t => { teacherNames[t.id] = t.name; });
      } catch(e){
        console.warn('Timetable: lecturer name lookup failed, using placeholder:', e);
      }
    }

    // Transform into SCHEDULE shape: { day, isToday, lectures: [...] }
    // where each lecture has { code, name, dept, lecturer, room, time, mode }
    const daysOfWeek = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });

    // Postgres `time` columns come back over the REST API as "HH:MM:SS"
    // (seconds included), not "HH:MM" — but parseLectureTimeRange() and
    // every display of a lecture's .time field expects the exact
    // "HH:MM – HH:MM" shape the mock data already uses. Truncating here
    // once, at the source, means every downstream consumer (the countdown
    // banner, compliance timing, the mock-layer conflict checks) keeps
    // working unchanged rather than needing its own defensive parsing.
    const toHHMM = (t) => (t || '').slice(0, 5);

    const liveSchedule = daysOfWeek.map(day => {
      const daySlots = rows.filter(r => r.day_of_week === day);
      const lectures = daySlots.map(slot => {
        const cls = slot.classes;
        const timeStr = `${toHHMM(slot.start_time)} – ${toHHMM(slot.end_time)}`; // en dash, same format as mock
        return {
          code: cls?.code || '',
          name: cls?.name || '',
          dept: cls?.programmes?.name || '',
          lecturer: teacherNames[slot.teacher_id] || 'TBA',
          room: slot.room,
          time: timeStr,
          mode: slot.mode || null,
          // Carries the real row id so editing/deleting a live-sourced
          // lecture can target it directly by id, rather than re-deriving
          // which row it was via a field-matching lookup that's fragile to
          // exactly this kind of format mismatch.
          _liveSlotId: slot.id,
        };
      });
      return {
        day,
        isToday: day === today,
        lectures,
      };
    });

    // Merge into existing SCHEDULE array.
    //
    // Why this needs more than a simple (day, code, room) match: that key
    // alone has two failure modes that pull in opposite directions.
    // Including time in the key breaks reschedules (a slot moved to a new
    // time would no longer match its old mock counterpart on the next
    // reload, since SCHEDULE always rebuilds fresh from the same static
    // mock baseline — so the stale old-time mock entry would keep showing
    // up alongside the new one). Excluding time fixes that, but then two
    // genuinely different sessions sharing the same course/room/day at
    // different times collide into a single merged entry, silently
    // dropping one of them.
    //
    // The actual fix: remember which specific mock entry a given live slot
    // claimed, persistently (localStorage — the same place this app
    // already keeps device-level preferences like the dark mode setting),
    // keyed by the live slot's own database id. Once a live slot has
    // claimed a mock entry once, every future reload recognizes it by that
    // id and updates the same entry directly, no matter how its time/day/
    // room have since changed. A brand-new live slot only ever needs the
    // simple content match on its first appearance; after that, its own id
    // takes over. Two distinct sessions in the same room/day don't
    // collide either, since a mock entry can only ever be claimed once —
    // the second live slot's first-time match simply finds a different
    // unclaimed entry (or adds a new one if none remain).
    const CLAIMS_KEY = 'vusap-timetable-claims';
    let claims = {};
    try { claims = JSON.parse(localStorage.getItem(CLAIMS_KEY) || '{}'); } catch(e){ claims = {}; }
    // Reverse lookup: live slot id -> the mock signature it already claimed
    const claimedSignatureByLiveId = {};
    Object.entries(claims).forEach(([sig, liveId]) => { claimedSignatureByLiveId[liveId] = sig; });
    const signatureOf = (day, l) => `${day}::${l.code}::${l.room}::${l.time}`;
    const claimedSignaturesThisRun = new Set(Object.keys(claims));

    liveSchedule.forEach(liveDay => {
      const existingDayIndex = SCHEDULE.findIndex(d => d.day === liveDay.day);
      if(existingDayIndex < 0){
        // Day doesn't exist in mock data at all — add the whole day, and
        // record a fresh claim for each of its slots so future reloads
        // recognize them by id too.
        liveDay.lectures.forEach(l => {
          const sig = signatureOf(liveDay.day, l);
          claims[sig] = l._liveSlotId;
        });
        SCHEDULE.push(liveDay);
        return;
      }

      const existingDay = SCHEDULE[existingDayIndex];
      liveDay.lectures.forEach(liveLecture => {
        const alreadyClaimedSig = claimedSignatureByLiveId[liveLecture._liveSlotId];
        let existingLectureIndex = -1;

        if(alreadyClaimedSig){
          // This live slot has claimed a mock entry before — find that
          // exact original entry (SCHEDULE is fresh from the static
          // baseline this reload, so its original signature still matches)
          // regardless of what this slot's current day/time/room say.
          existingLectureIndex = existingDay.lectures.findIndex(
            l => signatureOf(existingDay.day, l) === alreadyClaimedSig
          );
        }

        if(existingLectureIndex < 0){
          // No existing claim for this live slot yet — first-time match:
          // find an UNCLAIMED mock entry with the same (day, code, room).
          existingLectureIndex = existingDay.lectures.findIndex(l => {
            const sig = signatureOf(existingDay.day, l);
            return l.code === liveLecture.code && l.room === liveLecture.room && !claims[sig];
          });
          if(existingLectureIndex >= 0){
            const sig = signatureOf(existingDay.day, existingDay.lectures[existingLectureIndex]);
            claims[sig] = liveLecture._liveSlotId;
          }
        }

        if(existingLectureIndex >= 0){
          existingDay.lectures[existingLectureIndex] = liveLecture;
        } else {
          // Genuinely new — no unclaimed mock entry to match. Add it, and
          // record a claim under its own (new) signature so it's
          // recognized by id on future reloads too.
          existingDay.lectures.push(liveLecture);
          claims[signatureOf(existingDay.day, liveLecture)] = liveLecture._liveSlotId;
        }
      });
    });

    try { localStorage.setItem(CLAIMS_KEY, JSON.stringify(claims)); } catch(e){ /* storage unavailable — merge still works this run, just won't persist across reloads */ }
  } catch(e){
    console.warn('loadTimetableFromSupabase error, keeping mock SCHEDULE:', e);
  }
}

async function loadStudentsFromSupabase(){
  if(!LIVE_BACKEND) return;
  try {
    const { data: rows, error } = await SUPABASE_CLIENT
      .from('users')
      .select('*')
      .eq('role', 'student')
      .order('university_id');

    if(error){
      console.warn('Students fetch failed, keeping mock STUDENTS:', error);
      return;
    }
    if(!rows || rows.length === 0){
      // Table reachable but no student rows yet — keep mock data
      return;
    }

    // Fetch attendance statistics for all students in one batch query
    // This computes pct (present/total sessions) and trend (vs prior period)
    const studentIds = rows.map(r => r.id);
    let attendanceStats = {};
    try {
      const { data: attRows, error: attErr } = await SUPABASE_CLIENT
        .from('attendance')
        .select('student_id, status, marked_at')
        .in('student_id', studentIds);
      
      if(!attErr && attRows){
        // Group by student and compute statistics
        attRows.forEach(a => {
          if(!attendanceStats[a.student_id]){
            attendanceStats[a.student_id] = { present: 0, total: 0, recentPresent: 0, recentTotal: 0, olderPresent: 0, olderTotal: 0 };
          }
          attendanceStats[a.student_id].total++;
          if(a.status === 'present' || a.status === 'late'){
            attendanceStats[a.student_id].present++;
          }
          
          // Split into recent (last 30 days) vs older for trend calculation
          const now = new Date();
          const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          if(a.marked_at >= thirtyDaysAgo){
            attendanceStats[a.student_id].recentTotal++;
            if(a.status === 'present' || a.status === 'late'){
              attendanceStats[a.student_id].recentPresent++;
            }
          } else {
            attendanceStats[a.student_id].olderTotal++;
            if(a.status === 'present' || a.status === 'late'){
              attendanceStats[a.student_id].olderPresent++;
            }
          }
        });
      }
    } catch(e){
      console.warn('Attendance stats fetch failed, students will show no attendance data:', e);
      // Continue without attendance stats — students will have pct/trend = null
    }

    // Resolve programme info from the already-live PROGRAMMES array
    // (users.program may hold a programme key or name; resolve both ways)
    const resolveProgramme = (programField) => {
      if(!programField) return { deptKey: null, dept: null };
      const byKey = PROGRAMMES.find(p => p.key === programField);
      if(byKey) return { deptKey: byKey.key, dept: byKey.name };
      const byName = PROGRAMMES.find(p => p.name === programField);
      if(byName) return { deptKey: byName.key, dept: byName.name };
      return { deptKey: null, dept: null };
    };

    // Resolve faculty info from the already-live FACULTIES array
    const resolveFaculty = (facultyKey) => {
      if(!facultyKey) return { facultyKey: null, faculty: null };
      const fac = FACULTIES.find(f => f.key === facultyKey);
      return { facultyKey: fac ? fac.key : null, faculty: fac ? fac.name : null };
    };

    // Merge live students into the existing STUDENTS array
    // rather than fully replacing it — live students replace their matching
    // mock entry by reg (university_id), non-matching mock entries stay intact
    rows.forEach(row => {
      const programmeInfo = resolveProgramme(row.program);
      const facultyInfo = resolveFaculty(row.faculty_key);
      
      // Compute attendance percentage and trend
      let pct = null;
      let trend = null;
      const stats = attendanceStats[row.id];
      if(stats && stats.total > 0){
        pct = Math.round((stats.present / stats.total) * 100);
        // Trend: compare recent (last 30 days) vs older period
        if(stats.recentTotal > 0 && stats.olderTotal > 0){
          const recentPct = (stats.recentPresent / stats.recentTotal) * 100;
          const olderPct = (stats.olderPresent / stats.olderTotal) * 100;
          trend = recentPct >= olderPct ? 'up' : 'down';
        }
        // If insufficient data for trend, leave it as null (not 'up')
      }
      
      const existingIndex = STUDENTS.findIndex(s => s.reg === row.university_id);
      const liveStudent = {
        id: existingIndex >= 0 ? STUDENTS[existingIndex].id : STUDENTS.length + 1, // Keep existing ID if replacing, otherwise assign new
        name: row.name || '',
        reg: row.university_id || '',
        facultyKey: facultyInfo.facultyKey,
        faculty: facultyInfo.faculty,
        dept: programmeInfo.dept,
        deptKey: programmeInfo.deptKey,
        year: row.year || null, // null if not set, not a fabricated default
        pct: pct, // Computed from attendance table — null if no attendance rows
        trend: trend, // Computed from attendance table — null if no attendance rows or insufficient data
        gender: row.gender || null,
        semester: row.semester || null,
        mode: row.mode || null,
        email: row.email || '',
      };
      
      if(existingIndex >= 0){
        // Replace existing mock entry with live data
        STUDENTS[existingIndex] = liveStudent;
      } else {
        // Append new live student (no matching mock entry)
        STUDENTS.push(liveStudent);
      }
    });
  } catch(e){
    console.warn('loadStudentsFromSupabase error, keeping mock STUDENTS:', e);
  }
}

async function loadEnrollmentsFromSupabase(){
  if(!LIVE_BACKEND || !State.user || !State.user.supabaseId) return;
  try {
    const { data: rows, error } = await SUPABASE_CLIENT
      .from('enrollments')
      .select('class_id, classes(id, code, name, teacher_id)')
      .eq('student_id', State.user.supabaseId);

    if(error){
      console.warn('Enrollments fetch failed, keeping mock STUDENT_COURSES:', error);
      return;
    }
    if(!rows || rows.length === 0){
      // Table reachable but this student has no live enrollment rows yet
      // (expected until enrollments are actually seeded per-student) —
      // keep the mock course list rather than showing an empty schedule.
      return;
    }

    // `classes` has no lecturer NAME column, only teacher_id (FK -> users.id).
    // Batch-resolve the distinct teacher_ids to display names in one extra
    // query rather than one-per-course. If this second query fails, the
    // course list still loads, just with a placeholder lecturer name.
    const teacherIds = [...new Set(rows.map(r => r.classes && r.classes.teacher_id).filter(Boolean))];
    let teacherNames = {};
    if(teacherIds.length){
      try {
        const { data: teacherRows } = await SUPABASE_CLIENT
          .from('users')
          .select('id, name')
          .in('id', teacherIds);
        (teacherRows || []).forEach(t => { teacherNames[t.id] = t.name; });
      } catch(e){
        console.warn('Enrollments: lecturer name lookup failed, using placeholder:', e);
      }
    }

    const newCourses = rows
      .filter(r => r.classes)
      .map((r, i) => ({
        code: r.classes.code,
        name: r.classes.name,
        lecturer: teacherNames[r.classes.teacher_id] || 'TBA',
        // classes/enrollments carry no color; assigned client-side from a
        // fixed palette (cycled by position) purely for the existing UI's
        // course-color chips — same judgment call as palClass() elsewhere.
        color: STUDENT_COURSE_COLORS[i % STUDENT_COURSE_COLORS.length],
        classId: r.classes.id,
      }));

    if(newCourses.length){
      STUDENT_COURSES.length = 0;
      STUDENT_COURSES.push(...newCourses);
    }
  } catch(e){
    console.warn('loadEnrollmentsFromSupabase error, keeping mock STUDENT_COURSES:', e);
  }
}

// ============================================================
// VUSAP — App Data Layer & State
// ============================================================

// Official Victoria University shield logo, embedded as a data URI so it
// renders identically whether this app is served from a single file or
// deployed as the full multi-file PWA structure.
const VU_LOGO_DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAACeCAMAAACCYfHCAAAAflBMVEUAAAAub7DcKCzb2dvw8PCura7m5efm4OHbp6nLWF1GdaC3LTK0tLSu0uRfi6uYtMm0WVx+fn7qs7hBcJDLdoGGpse0q6vRvcJxo8e3srO0OkO48vPgwrzEusIsccGwsO4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACvYvAcAAAAIHRSTlMA/v7zE/pioPX+/v0F9f77/gKclve7qPr9XP0G+V3+CCfIvigAABF4SURBVHja7Z2JduK4EoaVlCwJr8B0A1mm8/5veeuvkmwZGzCGdM+5p3Vm6SQQPteu0tLGrBzW7vBfdyhmBnlnjdntrPkzw9b1FToh5OHkMepnQlpjb0jNQC61/NkV1wdRQQ6C5KexNvuMR/jAMBr5z/CVysNafyhuDyZUXfe/92H5zf6K+M2ICLpi+WBVe1/rr9jpZ6Tf+mHtWB67W4D8tC5/Qz3wyrutc+626LoJ4yckqRK8bpJXJVwbRx2Nh/f6jLUBuXeHYu3ooG62SEZw+uT8tN6zBWTDu2uI1ngqAh2PIDsYvNMyVi2Kxe8qHhgqVQjARZtkRv6l5kwiZncDEDadjDnZint7iG3Gt32iFN+pGfRwYDoW801Al9sCv/fN36HVdtnLPgPDBM/iy12SNV4skGBd16JZfvehoOP94mFdhrDIt2X8ZE64zxc8ehEgvIHwLriIuz2884MFufyLq8MnJ4xDQtgyQLP8Uyafyk9Ea99rlwF+MWDYrh3Btf0oebTXxtnPydrjAkAOT7R9XTmqjStf1g6i3wD4Yz1gyYBhIeDmTwC+/A7A1/93QPoL+BfwjwL6/zqgM/9/gFX1Xg3jLCjPfXcOsPw2wE3A+AxxjOS6CcOYBWwbDJQpjY6BBN/vf3Z6BHATUAVx/crlVzDngCiQ8IPNvAS5PmEGqX2p4y8GQP6i05KwyL8tgMWdKt4GbV/QdqLh9x/8I3f2gzMVN3jzh2/NRJ8tl46mnar4TkA2tCDT2VDNVAY8q2C+azbYypubmdKl/MlT3JfHAVmXomSaBWT9Vle9uCTMgru54oqVXK4F9CNrC4RWx0zkeYdhvt4C5PfOAb7MACKT3ATs+JHHNBuRwoyON0Sb6kYcxHu/G3AbMOEK2zkNb19vAn6/BKuApsw0u2ynFjgFbH4D4KthN/H+HGZWgDOAi1VcNn4lILsJy+GcZvs5I8BHJFg2bi0g3MSduUkFF3n9BgnaFYCvsELrt2cangveDwEukuA0DkKE3tiPsQjZRX68Ph0Qn39l4eLyxD2wAMffDrMafiQOQsVvWLmwKwpWtkJb5yLc0KyG/xjgNnjOJvSeA25f/0OAlQAOtvk+7yJ/DpDrUzT7eygucTavTwZEJlkPiEjDOt5cjTEPA5oHADdcdLmU77b0hwHn7D9w9Z48I/hLM9PzerD5bRKUSOMoqE9fEuBUgu4OQK+AH/enuujILlbW82l4HtDb+ZKfAZtpye8WAdp5D93yExqIDi7yvhAQ0zrfPBlwXoIQ4YfFNG47U+pfzsXuAiDP3V+eCyhVl2URsgC3S3szDc9+PS0EhIYeAeRZHPtJuBxjZgBP8lDlbE+/m/QHVYL1WkCd33nyfrO4u9WiP0LtFLClyXefAehlFfqyACeAmLnbOTduJj7yBMAqSJ/migCn7bcO3aOpjtuphhcCmmsNzC1mT/b4fgcgcslUhMw3hb4D8JKTYors/I/qng5ri1A9Tiboy8zY5RMkCBHmZettwF8iLc8ffCpTX0t6g+3LtwC+h2sxZh4Qnoxhmq7rm67ly/cAXkvDV5ro2OohC/OyjE9Ne2GdZAngjS5/Fa4K8GKXv1Xp8eja8uJCzhMAX81DyxBleXWl6RmAa9dJfi1ZCvuTgAuA/1uAM+pv7F/Av4AMSH8B/wJ+H6BZAtjY6yXz9+3dQgvYcay+DWg8llirFeO1KjzSbblq8LSTAd9uAH7KutfqsXfdT2N+rhrYJEp0CxALcx+0enDVt98bs18xsO+WAc1tCVrfrjSksixou1k5tqLi47+3vdj4dvXWkn8e2NpHmPAsAbQPAJ4eAlwowdleysLRPbB7E3sP6GiWAK6WYGkekaDDUQLzrRIsjX8EcIkXP6jih5xEGpjrbbDkqWPX3pj+/POwBFcBgq2RafdqwOo24JFWS7DBHngrSx7l9e1sU8CqQug2G9lCVRlsStvMtrg1zKwCRKM5nvxwTfPSUoNUU94CZChmYyCcQSAKYfuODWnS/ZDddMz9FBtsme9Dz0cZrIlL+4ea2QZQBojVAJyP8Cx9ksMVQXK1k5NCTk4l5KJcDVh26aARFjyxkQsHs9zQQStbcZ9yDLhBtz0eW2IhFoFwtIP/F/jffx26hs7nmxLXAmKLfXa8x+jJrh0TCmB7alIl0+aAFQBZSqagsCeRIrH499LlOh5xSAwbrrJe1FrAzk+P632YL+t991Ke0K86taBkebTnEgQHjsLB5EhOxDlYJMWzVnuXL/qtBGz99BAgv+SLX4Vtnn1h1hoR6QBogiE5sMOmF94MTtbhz3syh0PBhS2E6mcA780kHV0672j9KGcXNAYMDHgoCthfPD6HWsCRnDHibx6Lg/fh+Digtx+zZymZ2l8H3HocXHLe7AM4A94RDkQFTqSib+3nbNDcreJZAcrRO4dI8yv20gpZexucJISCtbiX43JYG/B71KN7y0L0cGr/rwB+PgrY+Csr4Pn6R3fmxQAMwEPIw3TKikUGc9CgeDwcAlxmADyuBEznFO30nK8ZlotKXbzMVaz7Dr2kEuSOvYCy87L8DLrqYouPArZkRxEwf7XstWpPkp9PWkeMnIQ/vwjFXvwVu6ahaD0Rx4wcrs0zJMhe4pTMTl8OEXlZ1CpFlmPAgOAMD97LQUWZ7QQcWzxq/PF+DBj8KsASdZYz8vuGlNJHxF0tuk074ccq9sYf9fwzdt4FKNxLZAyFfHOs4iCTJnd3Lm6lEvTEFaE7d2iLTQIsuy5VDmMJfrLhgQhuq8cwfUSj/YHDNyT4PgZc1N3yp/NVmNOpLU3ZzBxP9p7Z2n7taABkMcHmcCYXToKkYd0n/9kfUNcwI5twDqgT9zPAc7OPE/fZfSRl16GFtxsYd9ja2uV8Y0B8fkCpIGUXf7QoWAuHIE5yHAG6CWDNJY+xY0DOvXOb79kWT+wKWjkMxQ0iYcaXxUHEYifdGtLTvCS7v+To7h7bisnXlp9gO2g4AuaXOdhRMwln3AVwZmIMPjiMy4TPTtOO+QbAdwAi/NFRy1SvTsL/d36PHA3XY8BNlkjOt0YBKJco/KPwOADSzvIBZvBjlrdl/Z5Ga5c94BaAWu57tz9o3Q8nOeBsAKMjBdoBsNoQy8sXOWDNubGg3OzlFcBs5vl+vTD/Rzr5zjVhwXxlvrA1AsRSO3tHATr/Vkis2ZMWh3oWPwPEFkpDOaDIi0aA2sVmyz/Tcdkf7Glp9Oru1F2Yk2zIBExCOB17vbHASf0iRQauamC7fMsB8bkAGixcBViMJGjcZ0NWY1s+rWtG5y/iDIVf15wuTZq2APRyGYDVk+ZIPHqThFMH4NzHUbF/ICtAvjc54U2AQ7TBM+AU0ijbDRM4LrCdjZUCAGXKNANYQcVwA6vBEHkPQ+abQW8xgHGmZhM0nARoe2l1xZkE8Zl09DiF3+U9vzbbBmOGdIJXlWV+3itX8VaKmH1I59HF8AqTvkBKJp63bPoNL5hFkK0zCyTcHxHF0U8sqUPVke3FKXOXachEK2Fngam2401iOWAC03KLPvubASDG9FMFxOZE8W3H0d/ppSdWbsYQCULaZhcJ5Y4Ym4mwyz2G6X0vQA4w5dkOkwwwb/5rE5oneugmyGE9EH/iQgiZu2+gNdGw1a3yVjr+A6ClWDjv5GXODBVDO5JQKwWDVVmXItKRuQ6AOsxkj0NaU9Fmu5GZ+3tgHuO4oIgalghNRQJE/EMS64tQj9tMmiSz7mw3dro1B+G8pXHMHHJxtaznVqmC8dkMZPUsBLZ7eQXsSMXhNEKyfCX4QJ7uNLfPr+2noZZO001iq/qDW/lsXISi+q2hRvsWAVVwdaE/hQgdHBkvbF8mIio7UTFbjNea5zTuIa0BrHDiB3UE9QEMGS6q2A33uBBipJUZOfUnCmF0Xdp2JQdKkesgZyqf02HlLOw0BqofICUDVgCx6dPDJmU6LVE8Powknk5UyjVp0badtmGSji+cVFoBuKVYiFGaPQKtk6goxQ2mKfZAQltnTxB7G1262aSRsqWUQzbGzm/tXQG4/ZSzKkOZsOOCWVSLcAxar0pXfdfqQ76Q55FwLbLLdlx1qJuoeVITXU7tidHF268iTIw41mmFmAwyCTlZhJ1po7Yizid1+aWOZjM79mVMhKGDxmoFsXbwmN4M9AfdDGF7eY/YnYDiIL1JxQT1poBGUwl+woo9yDet60sVL7eiOTu/Ef9J6yTVxhMnL997MEKgUcB0SRXmIPoMAphUL6kaXSlH3fcByr5n1ZbtDTBKkOJFVeK5yTAhOB/7HCh2ZBO0774JkGtGLzvHk3dqCk4BMN0SaGxfXXu5FsnreoOJlmHukuEdgLC/+Cler1vrZxznfFajs9ckGONRIoQrNeXzAXE41EQ+06c4dl6dnasFMrpm5/7eQaF3fb2iduhdVz4bEPElyS9eyVfbmME4dyFzkNavqY9WC9VO7dJmMpRasmmfChivR3BYqHAmOYgWBKlF//bGT6A37ZHr7y60UbD9vC3e07bUEJcBVpvglE84bXIQEc4udUqHHosjN8yLY2zc5YQWV5ktUvMiwKheh4lfiru7OiYLdKdsXbNCye3qfsUj3rlX+zwpq5aLAo1BLgCXqHkJ4LvMkCw1UkzFSWIdI11h6ni/ZjbDk1ApukwS7NceNI7qdJUWbFdZALgJGrxENXLtIn55bUQ2XaHXRL6hhsq6aH3UsUN6sbna5XfpwshjgO8/SDsDupzYr6IaU2h8Vleh3lVz08PPfax1vM0J1RCnPZF7ASvcvyLzMmkX1kNv3lotB1wsEQryo87lQKgvs5KF4lWQUSGsmQ9P1y3xKiCCi5felFZOvYCwuBvLgSGFjG5Y1TcVKQdq/uh/BTxfBC9V7lXEK4A8E07a1V/Vd7GMzHpHKTjvcmWNECXXPjHKfJtaTZrTCxXrtYhzedeH2XxCKk6a6s4OfVPp65L23gYxnV+GGstXkpe6FABTPEQe0vJGnIVfdAnxEqAYn1pzkVlPXxxrWc8TyMg3XU5Q0RzkqkdJzJ7GD4KrJ2UJXbo87C3l4mln9b7RDrAuSfQZzKQ5ZFHsdPkAQupECrsLt+k6bSylsKTthtTRFy+O4QHJb2Yf5AygCI+imeP5XP7panpFLwQseuO22/mLkjndULyz1/Y5JT2NZMjexI1DE3GCeA5YAQ/JHNmqSPc/Z11yO0zXrF5ye/2+XSsrG7VVFRepFhrpORZCIsamay8DVoIn00qfjK8e3/ocb4wm3yddu7NXL9uVvjX/4/rWiOvzSmy8Qc9dXHFBSs0dJt/YI5any+24z5XGK5F134aOcU02YFw9QW6GvmYfMSk1PpNVWPul5iQfLQ/tadj8kbbnVRKU5XJmF23P5ld7W03Hab6rp8X4z/7WjdVapA4xW/o1fkibWS+70Bucjd5j3EgvvZRN4lF2zsSpd0dn0kstqn5CPqQ3425cqb3rZVhoeouNiUz2aiSYqrApIHWxGUBO6I/8Y7ZbE+IduCxcfsVRw0adyUaNUppCRKP0Yevbl3rvBkIr8/g6Jc/hzfxxkvWSGJ1ojL9h4gW9Gvilky/G+jUSQppLSBQkfyG9XZShyZsOu6FbcraSa5IG4zW5RneSeVbTh8CHdB/67mu8UF/HcgYPbzQ5a3pbeJ17DAua0G29q1M1DmEON/4ok09FiC54YVFa313IZryZW8RjXo/1Hr4q4l3Ay6+bj+nE92uvLj2itk+GW9eTGBGchMeqVPvL5EcXTsehCtGeCwp8F1NsbRaP1CbXBIol1VSFDVOBlH3Up6OuNVjIrYBndGY3LFDhceXaQP2y355431+roFUgZXGAJADiae3IYUxujqJu/csC7JlWMPvGfIn60McW+1MM+GvVhf15UCxSLynWZGasup1Vt5aL49UQpr8L2ylwzXi8zjv99Qw2mwHfOepUbOhfRuFQW8fC151FrNGd//Xk6n2tSqMr0SF7bit7M65i/A/3Ejxrx4d0rgAAAABJRU5ErkJggg==";
const VU_LOGO_MARK = `<img src="${VU_LOGO_DATA_URI}" alt="Victoria University" style="width:100%;height:100%;object-fit:contain;display:block;" />`;

const ICONS = {
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  dashboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`,
  users: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  records: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`,
  chevR: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M9 18l6-6-6-6"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
  trend: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 6l-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/></svg>`,
  book: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
  chart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M12 5v14M5 12h14"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
  filter: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>`,
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M17.94 17.94A10.94 10.94 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><path d="M1 1l22 22"/></svg>`,
  user: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`,
  logout: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>`,
  pin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 1118 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
  checkCircle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="64" height="64"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>`,
  inbox: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="40" height="40"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>`,
  schedule: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><circle cx="8" cy="15" r="1"/><circle cx="12" cy="15" r="1"/><circle cx="16" cy="15" r="1"/></svg>`,
  qrcode: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20v.01"/></svg>`,
  keypad: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="1.5"/><circle cx="12" cy="6" r="1.5"/><circle cx="18" cy="6" r="1.5"/><circle cx="6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/><circle cx="6" cy="18" r="1.5"/><circle cx="12" cy="18" r="1.5"/><circle cx="18" cy="18" r="1.5"/></svg>`,
  camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
  mail: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M22 6l-10 7L2 6"/></svg>`,
  flag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22V15"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  fileText: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>`,
  fileSpreadsheet: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8M8 13v4"/></svg>`,
  alertTriangle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>`,
  moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 005 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 005 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 5a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09A1.65 1.65 0 0015 5a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09A1.65 1.65 0 0019.4 15z"/></svg>`,
  graduation: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>`,
  database: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 5v6c0 1.66-4 3-9 3s-9-1.34-9-3V5"/><path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6"/></svg>`,
  userCog: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><circle cx="19" cy="16" r="2.5"/><path d="M19 12v1M19 19v1M16.4 14.2l.9.5M21.7 17.3l.9.5M16.4 17.8l.9-.5M21.7 14.7l.9-.5"/></svg>`,
  building: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9v.01M9 13v.01M9 17v.01M15 9v.01M15 13v.01M15 17v.01"/></svg>`,
  layers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></svg>`,
  sliders: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 002 2h12a2 2 0 002-2V8M10 12h4"/></svg>`,
  scaleIcon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 7l5-4 5 4M3 7c0 4 5 4 5 0M13 7l5-4 5 4M13 7c0 4 5 4 5 0M6 21h12"/></svg>`,
  gavel: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 10l-7.5 7.5a1.5 1.5 0 01-2-2L12 8M16 6l3 3M5 19h14M10.5 5.5l5 5M14 4l6 6"/></svg>`,
  megaphone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11v3a1 1 0 001 1h2l4.5 4.5a1 1 0 001.5-.9V6.4a1 1 0 00-1.5-.9L6 10H4a1 1 0 00-1 1z"/><path d="M17 8a5 5 0 010 8M20 5a8.5 8.5 0 010 14"/></svg>`,
};

// ---------- MOCK DATA ----------

// ============================================================
// FACULTY / PROGRAMME STRUCTURE (Faculty -> Programme -> Course -> Class)
// ============================================================
let FACULTIES = [{"key": "computing", "name": "Faculty of Computing & Informatics", "programmes": ["cs", "it", "swe"]}, {"key": "business", "name": "Faculty of Business & Management", "programmes": ["biz", "acc", "mkt"]}, {"key": "engineering", "name": "Faculty of Engineering", "programmes": ["civ", "eee", "mech"]}, {"key": "science", "name": "Faculty of Science", "programmes": ["bio", "chem", "math"]}, {"key": "arts", "name": "Faculty of Arts & Education", "programmes": ["edu", "mc"]}];

let PROGRAMMES = [{"facultyKey": "computing", "facultyName": "Faculty of Computing & Informatics", "key": "cs", "name": "Computer Science", "codePrefix": "CSF"}, {"facultyKey": "computing", "facultyName": "Faculty of Computing & Informatics", "key": "it", "name": "Information Technology", "codePrefix": "ITF"}, {"facultyKey": "computing", "facultyName": "Faculty of Computing & Informatics", "key": "swe", "name": "Software Engineering", "codePrefix": "SWF"}, {"facultyKey": "business", "facultyName": "Faculty of Business & Management", "key": "biz", "name": "Business Administration", "codePrefix": "BAF"}, {"facultyKey": "business", "facultyName": "Faculty of Business & Management", "key": "acc", "name": "Accounting & Finance", "codePrefix": "ACF"}, {"facultyKey": "business", "facultyName": "Faculty of Business & Management", "key": "mkt", "name": "Marketing", "codePrefix": "MKF"}, {"facultyKey": "engineering", "facultyName": "Faculty of Engineering", "key": "civ", "name": "Civil Engineering", "codePrefix": "CVF"}, {"facultyKey": "engineering", "facultyName": "Faculty of Engineering", "key": "eee", "name": "Electrical Engineering", "codePrefix": "EEF"}, {"facultyKey": "engineering", "facultyName": "Faculty of Engineering", "key": "mech", "name": "Mechanical Engineering", "codePrefix": "MEF"}, {"facultyKey": "science", "facultyName": "Faculty of Science", "key": "bio", "name": "Biology", "codePrefix": "BIF"}, {"facultyKey": "science", "facultyName": "Faculty of Science", "key": "chem", "name": "Chemistry", "codePrefix": "CHF"}, {"facultyKey": "science", "facultyName": "Faculty of Science", "key": "math", "name": "Mathematics & Statistics", "codePrefix": "MSF"}, {"facultyKey": "arts", "facultyName": "Faculty of Arts & Education", "key": "edu", "name": "Education", "codePrefix": "EDF"}, {"facultyKey": "arts", "facultyName": "Faculty of Arts & Education", "key": "mc", "name": "Mass Communication", "codePrefix": "MCF"}];

const PROGRAMME_TO_FACULTY = {"cs": "Faculty of Computing & Informatics", "it": "Faculty of Computing & Informatics", "swe": "Faculty of Computing & Informatics", "biz": "Faculty of Business & Management", "acc": "Faculty of Business & Management", "mkt": "Faculty of Business & Management", "civ": "Faculty of Engineering", "eee": "Faculty of Engineering", "mech": "Faculty of Engineering", "bio": "Faculty of Science", "chem": "Faculty of Science", "math": "Faculty of Science", "edu": "Faculty of Arts & Education", "mc": "Faculty of Arts & Education"};

const FACULTY_COUNTS = [{"key": "computing", "label": "Faculty of Computing & Informatics", "count": 113}, {"key": "business", "label": "Faculty of Business & Management", "count": 111}, {"key": "engineering", "label": "Faculty of Engineering", "count": 111}, {"key": "science", "label": "Faculty of Science", "count": 111}, {"key": "arts", "label": "Faculty of Arts & Education", "count": 74}];

const DEPT_COUNTS = [{"key": "cs", "label": "Computer Science", "facultyKey": "computing", "facultyLabel": "Faculty of Computing & Informatics", "count": 38}, {"key": "it", "label": "Information Technology", "facultyKey": "computing", "facultyLabel": "Faculty of Computing & Informatics", "count": 38}, {"key": "swe", "label": "Software Engineering", "facultyKey": "computing", "facultyLabel": "Faculty of Computing & Informatics", "count": 37}, {"key": "biz", "label": "Business Administration", "facultyKey": "business", "facultyLabel": "Faculty of Business & Management", "count": 37}, {"key": "acc", "label": "Accounting & Finance", "facultyKey": "business", "facultyLabel": "Faculty of Business & Management", "count": 37}, {"key": "mkt", "label": "Marketing", "facultyKey": "business", "facultyLabel": "Faculty of Business & Management", "count": 37}, {"key": "civ", "label": "Civil Engineering", "facultyKey": "engineering", "facultyLabel": "Faculty of Engineering", "count": 37}, {"key": "eee", "label": "Electrical Engineering", "facultyKey": "engineering", "facultyLabel": "Faculty of Engineering", "count": 37}, {"key": "mech", "label": "Mechanical Engineering", "facultyKey": "engineering", "facultyLabel": "Faculty of Engineering", "count": 37}, {"key": "bio", "label": "Biology", "facultyKey": "science", "facultyLabel": "Faculty of Science", "count": 37}, {"key": "chem", "label": "Chemistry", "facultyKey": "science", "facultyLabel": "Faculty of Science", "count": 37}, {"key": "math", "label": "Mathematics & Statistics", "facultyKey": "science", "facultyLabel": "Faculty of Science", "count": 37}, {"key": "edu", "label": "Education", "facultyKey": "arts", "facultyLabel": "Faculty of Arts & Education", "count": 37}, {"key": "mc", "label": "Mass Communication", "facultyKey": "arts", "facultyLabel": "Faculty of Arts & Education", "count": 37}];

// 520+ generated students across all programmes (legacy demo students reserved
// at their original registration numbers — see datagen/generate.py)
const STUDENTS = [{"id":1,"name":"Aisha Nakamya","reg":"VU-CSF-2401-0001-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 2","pct":97,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"a.nakamya@vu.ac.ug"},{"id":2,"name":"Brian Ssemwanga","reg":"VU-CSF-2401-0002-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 2","pct":98,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"b.ssemwanga@vu.ac.ug"},{"id":3,"name":"Christine Namboozo","reg":"VU-CSF-2401-0003-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 1","pct":100,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"c.namboozo@vu.ac.ug"},{"id":4,"name":"David Kiggundu","reg":"VU-CSF-2401-0004-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 1","pct":55,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"d.kiggundu@vu.ac.ug"},{"id":5,"name":"Esther Nalubega","reg":"VU-CSF-2401-0005-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 3","pct":91,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"e.nalubega@vu.ac.ug"},{"id":6,"name":"Fred Kibirige","reg":"VU-CSF-2401-0006-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 2","pct":8,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"f.kibirige@vu.ac.ug"},{"id":7,"name":"Grace Nakirya","reg":"VU-CSF-2401-0007-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 1","pct":100,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"g.nakirya@vu.ac.ug"},{"id":8,"name":"Hassan Mbazira","reg":"VU-CSF-2401-0008-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 2","pct":100,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"h.mbazira@vu.ac.ug"},{"id":9,"name":"Irene Namukasa","reg":"VU-CSF-2401-0009-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 3","pct":100,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"i.namukasa@vu.ac.ug"},{"id":10,"name":"Joseph Ssebuliba","reg":"VU-CSF-2401-0010-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 1","pct":97,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"j.ssebuliba@vu.ac.ug"},{"id":11,"name":"Victor Mbazira","reg":"VU-CSF-2401-0021-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 1","pct":79,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"v.mbazira@vu.ac.ug"},{"id":12,"name":"Andrew Nambooze","reg":"VU-CSF-2401-0022-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 3","pct":75,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"a.nambooze@vu.ac.ug"},{"id":13,"name":"Hellen Emmanuel","reg":"VU-CSF-2401-0023-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 3","pct":97,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"h.emmanuel@vu.ac.ug"},{"id":14,"name":"Immaculate Nansubuga","reg":"VU-CSF-2401-0024-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 3","pct":99,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"i.nansubuga@vu.ac.ug"},{"id":15,"name":"Dennis Ssegawa","reg":"VU-CSF-2401-0025-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 2","pct":70,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"d.ssegawa@vu.ac.ug"},{"id":16,"name":"Harriet Kibirige","reg":"VU-CSF-2401-0026-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 2","pct":94,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"h.kibirige@vu.ac.ug"},{"id":17,"name":"Mary Kizza","reg":"VU-CSF-2401-0027-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 2","pct":87,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"m.kizza@vu.ac.ug"},{"id":18,"name":"Kenneth Wabwa","reg":"VU-CSF-2401-0028-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 3","pct":93,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"k.wabwa@vu.ac.ug"},{"id":19,"name":"Eric Nalubega","reg":"VU-CSF-2401-0029-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 1","pct":77,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"e.nalubega19@vu.ac.ug"},{"id":20,"name":"Faridah Okwir","reg":"VU-CSF-2401-0030-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 2","pct":80,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"f.okwir@vu.ac.ug"},{"id":21,"name":"Cissy Annet","reg":"VU-CSF-2401-0031-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 3","pct":95,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"c.annet@vu.ac.ug"},{"id":22,"name":"Robert Kabuye","reg":"VU-CSF-2401-0032-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 1","pct":89,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"r.kabuye@vu.ac.ug"},{"id":23,"name":"Olivia Kabuye","reg":"VU-CSF-2401-0033-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 3","pct":99,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"o.kabuye@vu.ac.ug"},{"id":24,"name":"Janet Namboozo","reg":"VU-CSF-2401-0034-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 2","pct":58,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"j.namboozo@vu.ac.ug"},{"id":25,"name":"Felix Mukasa","reg":"VU-CSF-2401-0035-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 1","pct":95,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"f.mukasa@vu.ac.ug"},{"id":26,"name":"Stella Ssali","reg":"VU-CSF-2401-0036-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 1","pct":83,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"s.ssali@vu.ac.ug"},{"id":27,"name":"Oscar Namirembe","reg":"VU-CSF-2401-0037-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 2","pct":91,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"o.namirembe@vu.ac.ug"},{"id":28,"name":"Doreen Okello","reg":"VU-CSF-2401-0038-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 1","pct":67,"trend":"down","gender":"Female","semester":"Semester 1","mode":"evening","email":"d.okello@vu.ac.ug"},{"id":29,"name":"Benjamin Ssegawa","reg":"VU-CSF-2401-0039-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 3","pct":89,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"b.ssegawa@vu.ac.ug"},{"id":30,"name":"Kenneth Nakamya","reg":"VU-CSF-2401-0040-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 3","pct":92,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"k.nakamya@vu.ac.ug"},{"id":31,"name":"Martin Mugisha","reg":"VU-CSF-2401-0041-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 2","pct":89,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"m.mugisha@vu.ac.ug"},{"id":32,"name":"Geoffrey Kizza","reg":"VU-CSF-2401-0042-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 2","pct":91,"trend":"up","gender":"Female","semester":"Semester 1","mode":"evening","email":"g.kizza@vu.ac.ug"},{"id":33,"name":"Umar Nakaddwa","reg":"VU-CSF-2401-0043-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 3","pct":70,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"u.nakaddwa@vu.ac.ug"},{"id":34,"name":"Leo Sarah","reg":"VU-CSF-2401-0044-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 3","pct":75,"trend":"up","gender":"Female","semester":"Semester 2","mode":"evening","email":"l.sarah@vu.ac.ug"},{"id":35,"name":"Charles Ssemwanga","reg":"VU-CSF-2401-0045-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 1","pct":100,"trend":"up","gender":"Male","semester":"Semester 2","mode":"evening","email":"c.ssemwanga@vu.ac.ug"},{"id":36,"name":"Kevin Kiggundu","reg":"VU-CSF-2401-0046-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 1","pct":77,"trend":"down","gender":"Female","semester":"Semester 1","mode":"evening","email":"k.kiggundu@vu.ac.ug"},{"id":37,"name":"Sarah Okello","reg":"VU-CSF-2401-0047-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 3","pct":55,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"s.okello@vu.ac.ug"},{"id":38,"name":"Kenneth Sarah","reg":"VU-CSF-2401-0048-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 2","pct":81,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"k.sarah@vu.ac.ug"},{"id":39,"name":"Felix Nakaddwa","reg":"VU-ITF-2401-0049-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 2","pct":89,"trend":"down","gender":"Male","semester":"Semester 2","mode":"evening","email":"f.nakaddwa@vu.ac.ug"},{"id":40,"name":"Lillian Namutebi","reg":"VU-ITF-2401-0050-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 1","pct":null,"trend":null,"gender":"Female","semester":"Semester 1","mode":"day","email":"l.namutebi@vu.ac.ug"},{"id":41,"name":"Kenneth Emmanuel","reg":"VU-ITF-2401-0051-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 3","pct":60,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"k.emmanuel@vu.ac.ug"},{"id":42,"name":"Prossy Emmanuel","reg":"VU-ITF-2401-0052-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 1","pct":77,"trend":"up","gender":"Female","semester":"Semester 2","mode":"evening","email":"p.emmanuel@vu.ac.ug"},{"id":43,"name":"Patricia Nankunda","reg":"VU-ITF-2401-0053-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 2","pct":74,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"p.nankunda@vu.ac.ug"},{"id":44,"name":"Nelson Byaruhanga","reg":"VU-ITF-2401-0054-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 1","pct":81,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"n.byaruhanga@vu.ac.ug"},{"id":45,"name":"Faridah Nankunda","reg":"VU-ITF-2401-0055-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 2","pct":98,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"f.nankunda@vu.ac.ug"},{"id":46,"name":"Andrew Mugisha","reg":"VU-ITF-2401-0056-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 3","pct":85,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"a.mugisha@vu.ac.ug"},{"id":47,"name":"Linda Tendo","reg":"VU-ITF-2401-0057-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 1","pct":67,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"l.tendo@vu.ac.ug"},{"id":48,"name":"Patricia Wamala","reg":"VU-ITF-2401-0058-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 1","pct":57,"trend":"down","gender":"Female","semester":"Semester 1","mode":"evening","email":"p.wamala@vu.ac.ug"},{"id":49,"name":"Faridah Kiggundu","reg":"VU-ITF-2401-0059-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 3","pct":77,"trend":"up","gender":"Male","semester":"Semester 1","mode":"evening","email":"f.kiggundu@vu.ac.ug"},{"id":50,"name":"Betty Atim","reg":"VU-ITF-2401-0060-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 2","pct":76,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"b.atim@vu.ac.ug"},{"id":51,"name":"Faith Nakamya","reg":"VU-ITF-2401-0061-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 2","pct":89,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"f.nakamya@vu.ac.ug"},{"id":52,"name":"Joseph Wasswa","reg":"VU-ITF-2401-0062-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 3","pct":97,"trend":"down","gender":"Female","semester":"Semester 1","mode":"evening","email":"j.wasswa@vu.ac.ug"},{"id":53,"name":"Teddy Tendo","reg":"VU-ITF-2401-0063-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 2","pct":null,"trend":null,"gender":"Male","semester":"Semester 1","mode":"day","email":"t.tendo@vu.ac.ug"},{"id":54,"name":"Isaiah Achieng","reg":"VU-ITF-2401-0064-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 1","pct":null,"trend":null,"gender":"Female","semester":"Semester 2","mode":"day","email":"i.achieng@vu.ac.ug"},{"id":55,"name":"Oscar Byaruhanga","reg":"VU-ITF-2401-0065-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 3","pct":76,"trend":"up","gender":"Male","semester":"Semester 2","mode":"evening","email":"o.byaruhanga@vu.ac.ug"},{"id":56,"name":"Diana Nalubega","reg":"VU-ITF-2401-0066-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 3","pct":87,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"d.nalubega@vu.ac.ug"},{"id":57,"name":"Michael Namutebi","reg":"VU-ITF-2401-0067-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 3","pct":88,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"m.namutebi@vu.ac.ug"},{"id":58,"name":"Norah Annet","reg":"VU-ITF-2401-0068-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 3","pct":87,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"n.annet@vu.ac.ug"},{"id":59,"name":"Zack Mugisha","reg":"VU-ITF-2401-0069-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 2","pct":77,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"z.mugisha@vu.ac.ug"},{"id":60,"name":"Timothy Nantongo","reg":"VU-ITF-2401-0070-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 3","pct":46,"trend":"down","gender":"Female","semester":"Semester 1","mode":"evening","email":"t.nantongo@vu.ac.ug"},{"id":61,"name":"Emmanuel Ssali","reg":"VU-ITF-2401-0071-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 1","pct":82,"trend":"up","gender":"Male","semester":"Semester 1","mode":"evening","email":"e.ssali@vu.ac.ug"},{"id":62,"name":"Queen Sarah","reg":"VU-ITF-2401-0072-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 2","pct":94,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"q.sarah@vu.ac.ug"},{"id":63,"name":"Zack Lubega","reg":"VU-ITF-2401-0073-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 2","pct":44,"trend":"down","gender":"Male","semester":"Semester 2","mode":"evening","email":"z.lubega@vu.ac.ug"},{"id":64,"name":"Norah Mbazira","reg":"VU-ITF-2401-0074-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 1","pct":69,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"n.mbazira@vu.ac.ug"},{"id":65,"name":"Robert Annet","reg":"VU-ITF-2401-0075-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 3","pct":83,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"r.annet@vu.ac.ug"},{"id":66,"name":"Margaret Kiggundu","reg":"VU-ITF-2401-0076-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 1","pct":76,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"m.kiggundu@vu.ac.ug"},{"id":67,"name":"Zainab Tushabe","reg":"VU-ITF-2401-0077-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 1","pct":98,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"z.tushabe@vu.ac.ug"},{"id":68,"name":"Kenneth Naggayi","reg":"VU-ITF-2401-0078-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 2","pct":62,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"k.naggayi@vu.ac.ug"},{"id":69,"name":"Teddy Achieng","reg":"VU-ITF-2401-0079-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 1","pct":79,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"t.achieng@vu.ac.ug"},{"id":70,"name":"Patience Namboozo","reg":"VU-ITF-2401-0080-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 2","pct":76,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"p.namboozo@vu.ac.ug"},{"id":71,"name":"Gloria Apio","reg":"VU-ITF-2401-0081-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 1","pct":92,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"g.apio@vu.ac.ug"},{"id":72,"name":"Tom Nambooze","reg":"VU-ITF-2401-0082-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 1","pct":80,"trend":"up","gender":"Female","semester":"Semester 1","mode":"evening","email":"t.nambooze@vu.ac.ug"},{"id":73,"name":"Fred Ssemwanga","reg":"VU-ITF-2401-0083-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 1","pct":88,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"f.ssemwanga@vu.ac.ug"},{"id":74,"name":"Olivia Sarah","reg":"VU-ITF-2401-0084-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 3","pct":90,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"o.sarah@vu.ac.ug"},{"id":75,"name":"Florence Wamala","reg":"VU-ITF-2401-0085-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 2","pct":82,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"f.wamala@vu.ac.ug"},{"id":76,"name":"Grace Nankunda","reg":"VU-ITF-2401-0086-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Information Technology","deptKey":"it","year":"Year 1","pct":77,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"g.nankunda@vu.ac.ug"},{"id":77,"name":"Brenda Mugisha","reg":"VU-SWF-2401-0087-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 3","pct":92,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"b.mugisha@vu.ac.ug"},{"id":78,"name":"Grace Mbazira","reg":"VU-SWF-2401-0088-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 2","pct":83,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"g.mbazira@vu.ac.ug"},{"id":79,"name":"Harriet Bbosa","reg":"VU-SWF-2401-0089-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 2","pct":88,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"h.bbosa@vu.ac.ug"},{"id":80,"name":"Gertrude Namatovu","reg":"VU-SWF-2401-0090-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 1","pct":75,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"g.namatovu@vu.ac.ug"},{"id":81,"name":"Damalie Ssegawa","reg":"VU-SWF-2401-0091-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 1","pct":94,"trend":"up","gender":"Male","semester":"Semester 1","mode":"evening","email":"d.ssegawa81@vu.ac.ug"},{"id":82,"name":"Yusuf Mbazira","reg":"VU-SWF-2401-0092-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 3","pct":96,"trend":"down","gender":"Female","semester":"Semester 2","mode":"evening","email":"y.mbazira@vu.ac.ug"},{"id":83,"name":"Yvonne Namirembe","reg":"VU-SWF-2401-0093-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 3","pct":53,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"y.namirembe@vu.ac.ug"},{"id":84,"name":"Zack Okwir","reg":"VU-SWF-2401-0094-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 3","pct":74,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"z.okwir@vu.ac.ug"},{"id":85,"name":"Susan Namirembe","reg":"VU-SWF-2401-0095-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 3","pct":81,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"s.namirembe@vu.ac.ug"},{"id":86,"name":"Oscar Bbosa","reg":"VU-SWF-2401-0096-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 3","pct":96,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"o.bbosa@vu.ac.ug"},{"id":87,"name":"Frank Byaruhanga","reg":"VU-SWF-2401-0097-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 3","pct":56,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"f.byaruhanga@vu.ac.ug"},{"id":88,"name":"Yusuf Kabuye","reg":"VU-SWF-2401-0098-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 3","pct":99,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"y.kabuye@vu.ac.ug"},{"id":89,"name":"Andrew Nakaddwa","reg":"VU-SWF-2401-0099-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 1","pct":65,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"a.nakaddwa@vu.ac.ug"},{"id":90,"name":"Linda Byaruhanga","reg":"VU-SWF-2401-0100-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 3","pct":53,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"l.byaruhanga@vu.ac.ug"},{"id":91,"name":"Umar Namatovu","reg":"VU-SWF-2401-0101-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 1","pct":87,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"u.namatovu@vu.ac.ug"},{"id":92,"name":"Stella Mugisha","reg":"VU-SWF-2401-0102-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 3","pct":99,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"s.mugisha@vu.ac.ug"},{"id":93,"name":"Nathan Ssegawa","reg":"VU-SWF-2401-0103-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 1","pct":91,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"n.ssegawa@vu.ac.ug"},{"id":94,"name":"Nabaale Lubega","reg":"VU-SWF-2401-0104-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 1","pct":44,"trend":"down","gender":"Female","semester":"Semester 2","mode":"evening","email":"n.lubega@vu.ac.ug"},{"id":95,"name":"Ivan Nankunda","reg":"VU-SWF-2401-0105-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 3","pct":99,"trend":"down","gender":"Male","semester":"Semester 2","mode":"evening","email":"i.nankunda@vu.ac.ug"},{"id":96,"name":"Simon Kizza","reg":"VU-SWF-2401-0106-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 3","pct":89,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"s.kizza@vu.ac.ug"},{"id":97,"name":"Julius Byaruhanga","reg":"VU-SWF-2401-0107-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 2","pct":95,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"j.byaruhanga@vu.ac.ug"},{"id":98,"name":"Martin Tushabe","reg":"VU-SWF-2401-0108-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 3","pct":89,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"m.tushabe@vu.ac.ug"},{"id":99,"name":"Felix Wabwa","reg":"VU-SWF-2401-0109-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 1","pct":92,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"f.wabwa@vu.ac.ug"},{"id":100,"name":"Rachel Ssebuliba","reg":"VU-SWF-2401-0110-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 1","pct":68,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"r.ssebuliba@vu.ac.ug"},{"id":101,"name":"Sarah Atim","reg":"VU-SWF-2401-0111-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 2","pct":76,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"s.atim@vu.ac.ug"},{"id":102,"name":"Hassan Okwir","reg":"VU-SWF-2401-0112-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 3","pct":null,"trend":null,"gender":"Female","semester":"Semester 2","mode":"evening","email":"h.okwir@vu.ac.ug"},{"id":103,"name":"Leo Namatovu","reg":"VU-SWF-2401-0113-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 2","pct":84,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"l.namatovu@vu.ac.ug"},{"id":104,"name":"Hassan Achieng","reg":"VU-SWF-2401-0114-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 3","pct":82,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"h.achieng@vu.ac.ug"},{"id":105,"name":"Immaculate Nabukyeyo","reg":"VU-SWF-2401-0115-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 2","pct":96,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"i.nabukyeyo@vu.ac.ug"},{"id":106,"name":"Geoffrey Sarah","reg":"VU-SWF-2401-0116-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 2","pct":92,"trend":"up","gender":"Female","semester":"Semester 2","mode":"evening","email":"g.sarah@vu.ac.ug"},{"id":107,"name":"Brian Kyeyune","reg":"VU-SWF-2401-0117-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 3","pct":53,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"b.kyeyune@vu.ac.ug"},{"id":108,"name":"Rachel Wamala","reg":"VU-SWF-2401-0118-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 1","pct":81,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"r.wamala@vu.ac.ug"},{"id":109,"name":"Yvonne Akwango","reg":"VU-SWF-2401-0119-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 2","pct":88,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"y.akwango@vu.ac.ug"},{"id":110,"name":"Brenda Byaruhanga","reg":"VU-SWF-2401-0120-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 1","pct":null,"trend":null,"gender":"Female","semester":"Semester 2","mode":"day","email":"b.byaruhanga@vu.ac.ug"},{"id":111,"name":"Brenda Emmanuel","reg":"VU-SWF-2401-0121-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 3","pct":76,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"b.emmanuel@vu.ac.ug"},{"id":112,"name":"Esther Nantongo","reg":"VU-SWF-2401-0122-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 1","pct":78,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"e.nantongo@vu.ac.ug"},{"id":113,"name":"Ivan Wasswa","reg":"VU-SWF-2401-0123-DAY","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Software Engineering","deptKey":"swe","year":"Year 2","pct":74,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"i.wasswa@vu.ac.ug"},{"id":114,"name":"Kampire Sarah","reg":"VU-BAF-2401-0011-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 2","pct":100,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"k.sarah114@vu.ac.ug"},{"id":115,"name":"Lwanga Moses","reg":"VU-BAF-2401-0012-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 1","pct":100,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"l.moses@vu.ac.ug"},{"id":116,"name":"Mary Tendo","reg":"VU-BAF-2401-0013-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 3","pct":100,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"m.tendo@vu.ac.ug"},{"id":117,"name":"Nabaale Annet","reg":"VU-BAF-2401-0014-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 1","pct":100,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"n.annet117@vu.ac.ug"},{"id":118,"name":"Opio Emmanuel","reg":"VU-BAF-2401-0015-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 2","pct":8,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"o.emmanuel@vu.ac.ug"},{"id":119,"name":"Prossy Namutebi","reg":"VU-BAF-2401-0016-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 2","pct":100,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"p.namutebi@vu.ac.ug"},{"id":120,"name":"Julius Naggayi","reg":"VU-BAF-2401-0124-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 1","pct":69,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"j.naggayi@vu.ac.ug"},{"id":121,"name":"Harriet Kyeyune","reg":"VU-BAF-2401-0125-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 1","pct":87,"trend":"down","gender":"Male","semester":"Semester 1","mode":"evening","email":"h.kyeyune@vu.ac.ug"},{"id":122,"name":"Felix Tendo","reg":"VU-BAF-2401-0126-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 1","pct":82,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"f.tendo@vu.ac.ug"},{"id":123,"name":"Dennis Tushabe","reg":"VU-BAF-2401-0127-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 2","pct":78,"trend":"up","gender":"Male","semester":"Semester 2","mode":"evening","email":"d.tushabe@vu.ac.ug"},{"id":124,"name":"Brenda Achieng","reg":"VU-BAF-2401-0128-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 2","pct":60,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"b.achieng@vu.ac.ug"},{"id":125,"name":"Annet Nakamya","reg":"VU-BAF-2401-0129-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 2","pct":51,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"a.nakamya125@vu.ac.ug"},{"id":126,"name":"Victor Wamala","reg":"VU-BAF-2401-0130-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 3","pct":73,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"v.wamala@vu.ac.ug"},{"id":127,"name":"Xavier Nabukyeyo","reg":"VU-BAF-2401-0131-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 3","pct":90,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"x.nabukyeyo@vu.ac.ug"},{"id":128,"name":"Lwanga Kizza","reg":"VU-BAF-2401-0132-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 3","pct":77,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"l.kizza@vu.ac.ug"},{"id":129,"name":"Ronald Namutebi","reg":"VU-BAF-2401-0133-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 2","pct":85,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"r.namutebi@vu.ac.ug"},{"id":130,"name":"Daniel Mukasa","reg":"VU-BAF-2401-0134-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 1","pct":83,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"d.mukasa@vu.ac.ug"},{"id":131,"name":"Patricia Bbosa","reg":"VU-BAF-2401-0135-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 3","pct":91,"trend":"up","gender":"Male","semester":"Semester 2","mode":"evening","email":"p.bbosa@vu.ac.ug"},{"id":132,"name":"Brenda Namutebi","reg":"VU-BAF-2401-0136-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 3","pct":82,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"b.namutebi@vu.ac.ug"},{"id":133,"name":"Walter Naggayi","reg":"VU-BAF-2401-0137-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 2","pct":null,"trend":null,"gender":"Male","semester":"Semester 1","mode":"day","email":"w.naggayi@vu.ac.ug"},{"id":134,"name":"Rose Emmanuel","reg":"VU-BAF-2401-0138-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 2","pct":93,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"r.emmanuel@vu.ac.ug"},{"id":135,"name":"Alex Lubega","reg":"VU-BAF-2401-0139-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 3","pct":92,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"a.lubega@vu.ac.ug"},{"id":136,"name":"Cissy Wasswa","reg":"VU-BAF-2401-0140-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 2","pct":78,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"c.wasswa@vu.ac.ug"},{"id":137,"name":"Viola Mbazira","reg":"VU-BAF-2401-0141-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 3","pct":80,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"v.mbazira137@vu.ac.ug"},{"id":138,"name":"Hellen Nambooze","reg":"VU-BAF-2401-0142-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 2","pct":99,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"h.nambooze@vu.ac.ug"},{"id":139,"name":"Faridah Tendo","reg":"VU-BAF-2401-0143-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 2","pct":65,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"f.tendo139@vu.ac.ug"},{"id":140,"name":"Eric Achieng","reg":"VU-BAF-2401-0144-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 1","pct":92,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"e.achieng@vu.ac.ug"},{"id":141,"name":"Dennis Namukasa","reg":"VU-BAF-2401-0145-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 3","pct":75,"trend":"up","gender":"Male","semester":"Semester 1","mode":"evening","email":"d.namukasa@vu.ac.ug"},{"id":142,"name":"Alex Byaruhanga","reg":"VU-BAF-2401-0146-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 2","pct":83,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"a.byaruhanga@vu.ac.ug"},{"id":143,"name":"Joan Nalubega","reg":"VU-BAF-2401-0147-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 2","pct":96,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"j.nalubega@vu.ac.ug"},{"id":144,"name":"Teddy Ssebuliba","reg":"VU-BAF-2401-0148-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 3","pct":47,"trend":"down","gender":"Female","semester":"Semester 1","mode":"evening","email":"t.ssebuliba@vu.ac.ug"},{"id":145,"name":"Lillian Lubega","reg":"VU-BAF-2401-0149-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 2","pct":82,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"l.lubega@vu.ac.ug"},{"id":146,"name":"Ronald Nansubuga","reg":"VU-BAF-2401-0150-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 2","pct":84,"trend":"up","gender":"Female","semester":"Semester 2","mode":"evening","email":"r.nansubuga@vu.ac.ug"},{"id":147,"name":"Simon Nambooze","reg":"VU-BAF-2401-0151-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 1","pct":68,"trend":"down","gender":"Male","semester":"Semester 2","mode":"evening","email":"s.nambooze@vu.ac.ug"},{"id":148,"name":"Norah Nankunda","reg":"VU-BAF-2401-0152-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 1","pct":66,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"n.nankunda@vu.ac.ug"},{"id":149,"name":"Agnes Nakamya","reg":"VU-BAF-2401-0153-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 2","pct":84,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"a.nakamya149@vu.ac.ug"},{"id":150,"name":"Janet Wabwa","reg":"VU-BAF-2401-0154-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Business Administration","deptKey":"biz","year":"Year 3","pct":77,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"j.wabwa@vu.ac.ug"},{"id":151,"name":"Norah Kabuye","reg":"VU-ACF-2401-0155-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 3","pct":88,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"n.kabuye@vu.ac.ug"},{"id":152,"name":"James Emmanuel","reg":"VU-ACF-2401-0156-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 3","pct":79,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"j.emmanuel@vu.ac.ug"},{"id":153,"name":"Prossy Sarah","reg":"VU-ACF-2401-0157-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 2","pct":84,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"p.sarah@vu.ac.ug"},{"id":154,"name":"Lillian Wamala","reg":"VU-ACF-2401-0158-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 3","pct":83,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"l.wamala@vu.ac.ug"},{"id":155,"name":"Opio Kibirige","reg":"VU-ACF-2401-0159-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 3","pct":85,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"o.kibirige@vu.ac.ug"},{"id":156,"name":"Grace Kibirige","reg":"VU-ACF-2401-0160-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 1","pct":93,"trend":"up","gender":"Female","semester":"Semester 1","mode":"evening","email":"g.kibirige@vu.ac.ug"},{"id":157,"name":"Leo Apio","reg":"VU-ACF-2401-0161-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 2","pct":80,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"l.apio@vu.ac.ug"},{"id":158,"name":"George Mugisha","reg":"VU-ACF-2401-0162-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 2","pct":74,"trend":"down","gender":"Female","semester":"Semester 2","mode":"evening","email":"g.mugisha@vu.ac.ug"},{"id":159,"name":"Lwanga Kabuye","reg":"VU-ACF-2401-0163-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 2","pct":88,"trend":"up","gender":"Male","semester":"Semester 2","mode":"evening","email":"l.kabuye@vu.ac.ug"},{"id":160,"name":"Yvonne Nankunda","reg":"VU-ACF-2401-0164-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 1","pct":97,"trend":"down","gender":"Female","semester":"Semester 1","mode":"evening","email":"y.nankunda@vu.ac.ug"},{"id":161,"name":"Queen Nankunda","reg":"VU-ACF-2401-0165-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 2","pct":89,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"q.nankunda@vu.ac.ug"},{"id":162,"name":"Viola Ssali","reg":"VU-ACF-2401-0166-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 2","pct":91,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"v.ssali@vu.ac.ug"},{"id":163,"name":"Yusuf Achieng","reg":"VU-ACF-2401-0167-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 2","pct":70,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"y.achieng@vu.ac.ug"},{"id":164,"name":"Tom Okello","reg":"VU-ACF-2401-0168-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 2","pct":81,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"t.okello@vu.ac.ug"},{"id":165,"name":"Kenneth Namukasa","reg":"VU-ACF-2401-0169-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 2","pct":78,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"k.namukasa@vu.ac.ug"},{"id":166,"name":"Umar Bbosa","reg":"VU-ACF-2401-0170-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 1","pct":75,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"u.bbosa@vu.ac.ug"},{"id":167,"name":"Doreen Emmanuel","reg":"VU-ACF-2401-0171-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 1","pct":44,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"d.emmanuel@vu.ac.ug"},{"id":168,"name":"Daniel Naggayi","reg":"VU-ACF-2401-0172-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 2","pct":90,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"d.naggayi@vu.ac.ug"},{"id":169,"name":"Linda Wamala","reg":"VU-ACF-2401-0173-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 3","pct":74,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"l.wamala169@vu.ac.ug"},{"id":170,"name":"Frank Nambooze","reg":"VU-ACF-2401-0174-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 1","pct":100,"trend":"down","gender":"Female","semester":"Semester 2","mode":"evening","email":"f.nambooze@vu.ac.ug"},{"id":171,"name":"Annet Nankya","reg":"VU-ACF-2401-0175-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 2","pct":84,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"a.nankya@vu.ac.ug"},{"id":172,"name":"Teddy Nansubuga","reg":"VU-ACF-2401-0176-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 3","pct":99,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"t.nansubuga@vu.ac.ug"},{"id":173,"name":"Timothy Mukasa","reg":"VU-ACF-2401-0177-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 1","pct":87,"trend":"up","gender":"Male","semester":"Semester 1","mode":"evening","email":"t.mukasa@vu.ac.ug"},{"id":174,"name":"Nathan Atim","reg":"VU-ACF-2401-0178-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 1","pct":100,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"n.atim@vu.ac.ug"},{"id":175,"name":"Gertrude Nankunda","reg":"VU-ACF-2401-0179-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 3","pct":76,"trend":"up","gender":"Male","semester":"Semester 2","mode":"evening","email":"g.nankunda175@vu.ac.ug"},{"id":176,"name":"Emmanuel Kyeyune","reg":"VU-ACF-2401-0180-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 2","pct":89,"trend":"up","gender":"Female","semester":"Semester 1","mode":"evening","email":"e.kyeyune@vu.ac.ug"},{"id":177,"name":"Henry Wamala","reg":"VU-ACF-2401-0181-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 1","pct":95,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"h.wamala@vu.ac.ug"},{"id":178,"name":"Winnie Byaruhanga","reg":"VU-ACF-2401-0182-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 2","pct":95,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"w.byaruhanga@vu.ac.ug"},{"id":179,"name":"Zainab Apio","reg":"VU-ACF-2401-0183-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 3","pct":97,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"z.apio@vu.ac.ug"},{"id":180,"name":"James Namboozo","reg":"VU-ACF-2401-0184-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 3","pct":84,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"j.namboozo180@vu.ac.ug"},{"id":181,"name":"Julius Kibirige","reg":"VU-ACF-2401-0185-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 2","pct":97,"trend":"up","gender":"Male","semester":"Semester 1","mode":"evening","email":"j.kibirige@vu.ac.ug"},{"id":182,"name":"Opio Sarah","reg":"VU-ACF-2401-0186-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 3","pct":null,"trend":null,"gender":"Female","semester":"Semester 2","mode":"day","email":"o.sarah182@vu.ac.ug"},{"id":183,"name":"Yvonne Kiggundu","reg":"VU-ACF-2401-0187-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 2","pct":82,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"y.kiggundu@vu.ac.ug"},{"id":184,"name":"Michael Apio","reg":"VU-ACF-2401-0188-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 1","pct":52,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"m.apio@vu.ac.ug"},{"id":185,"name":"Tom Apio","reg":"VU-ACF-2401-0189-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 1","pct":82,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"t.apio@vu.ac.ug"},{"id":186,"name":"Victor Ssali","reg":"VU-ACF-2401-0190-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 2","pct":null,"trend":null,"gender":"Female","semester":"Semester 2","mode":"day","email":"v.ssali186@vu.ac.ug"},{"id":187,"name":"Ivan Wabwa","reg":"VU-ACF-2401-0191-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Accounting & Finance","deptKey":"acc","year":"Year 3","pct":51,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"i.wabwa@vu.ac.ug"},{"id":188,"name":"Peter Nakaddwa","reg":"VU-MKF-2401-0192-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 3","pct":89,"trend":"up","gender":"Female","semester":"Semester 1","mode":"evening","email":"p.nakaddwa@vu.ac.ug"},{"id":189,"name":"Florence Okwir","reg":"VU-MKF-2401-0193-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 2","pct":86,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"f.okwir189@vu.ac.ug"},{"id":190,"name":"Dennis Wabwa","reg":"VU-MKF-2401-0194-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 1","pct":83,"trend":"up","gender":"Female","semester":"Semester 2","mode":"evening","email":"d.wabwa@vu.ac.ug"},{"id":191,"name":"Nathan Nambooze","reg":"VU-MKF-2401-0195-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 1","pct":84,"trend":"up","gender":"Male","semester":"Semester 2","mode":"evening","email":"n.nambooze@vu.ac.ug"},{"id":192,"name":"Robert Tumwesigye","reg":"VU-MKF-2401-0196-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 1","pct":96,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"r.tumwesigye@vu.ac.ug"},{"id":193,"name":"Umar Nakirya","reg":"VU-MKF-2401-0197-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 3","pct":89,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"u.nakirya@vu.ac.ug"},{"id":194,"name":"Oscar Otim","reg":"VU-MKF-2401-0198-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 3","pct":85,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"o.otim@vu.ac.ug"},{"id":195,"name":"Carol Tendo","reg":"VU-MKF-2401-0199-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 1","pct":86,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"c.tendo@vu.ac.ug"},{"id":196,"name":"Betty Ssali","reg":"VU-MKF-2401-0200-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 2","pct":85,"trend":"up","gender":"Female","semester":"Semester 1","mode":"evening","email":"b.ssali@vu.ac.ug"},{"id":197,"name":"Ivan Nalubega","reg":"VU-MKF-2401-0201-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 1","pct":96,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"i.nalubega@vu.ac.ug"},{"id":198,"name":"Lawrence Otim","reg":"VU-MKF-2401-0202-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 1","pct":null,"trend":null,"gender":"Female","semester":"Semester 2","mode":"day","email":"l.otim@vu.ac.ug"},{"id":199,"name":"Isaac Mbazira","reg":"VU-MKF-2401-0203-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 2","pct":83,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"i.mbazira@vu.ac.ug"},{"id":200,"name":"Victor Otim","reg":"VU-MKF-2401-0204-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 1","pct":94,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"v.otim@vu.ac.ug"},{"id":201,"name":"Simon Emmanuel","reg":"VU-MKF-2401-0205-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 3","pct":97,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"s.emmanuel@vu.ac.ug"},{"id":202,"name":"Xavier Atim","reg":"VU-MKF-2401-0206-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 1","pct":84,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"x.atim@vu.ac.ug"},{"id":203,"name":"Joan Nakirya","reg":"VU-MKF-2401-0207-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 1","pct":72,"trend":"down","gender":"Male","semester":"Semester 2","mode":"evening","email":"j.nakirya@vu.ac.ug"},{"id":204,"name":"Eve Nankunda","reg":"VU-MKF-2401-0208-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 3","pct":93,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"e.nankunda@vu.ac.ug"},{"id":205,"name":"Hassan Mugisha","reg":"VU-MKF-2401-0209-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 1","pct":83,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"h.mugisha@vu.ac.ug"},{"id":206,"name":"Collins Otim","reg":"VU-MKF-2401-0210-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 1","pct":86,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"c.otim@vu.ac.ug"},{"id":207,"name":"Benjamin Otim","reg":"VU-MKF-2401-0211-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 3","pct":76,"trend":"down","gender":"Male","semester":"Semester 2","mode":"evening","email":"b.otim@vu.ac.ug"},{"id":208,"name":"Patricia Tendo","reg":"VU-MKF-2401-0212-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 1","pct":77,"trend":"up","gender":"Female","semester":"Semester 1","mode":"evening","email":"p.tendo@vu.ac.ug"},{"id":209,"name":"Walter Kabuye","reg":"VU-MKF-2401-0213-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 3","pct":null,"trend":null,"gender":"Male","semester":"Semester 1","mode":"evening","email":"w.kabuye@vu.ac.ug"},{"id":210,"name":"Zainab Namutebi","reg":"VU-MKF-2401-0214-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 1","pct":73,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"z.namutebi@vu.ac.ug"},{"id":211,"name":"Gloria Kyeyune","reg":"VU-MKF-2401-0215-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 1","pct":99,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"g.kyeyune@vu.ac.ug"},{"id":212,"name":"Quincy Nakamya","reg":"VU-MKF-2401-0216-EVE","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 2","pct":67,"trend":"down","gender":"Female","semester":"Semester 1","mode":"evening","email":"q.nakamya@vu.ac.ug"},{"id":213,"name":"James Ssali","reg":"VU-MKF-2401-0217-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 1","pct":79,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"j.ssali@vu.ac.ug"},{"id":214,"name":"Cissy Namutebi","reg":"VU-MKF-2401-0218-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 3","pct":65,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"c.namutebi@vu.ac.ug"},{"id":215,"name":"Patience Nambooze","reg":"VU-MKF-2401-0219-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 2","pct":90,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"p.nambooze@vu.ac.ug"},{"id":216,"name":"Nathan Otim","reg":"VU-MKF-2401-0220-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 3","pct":82,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"n.otim@vu.ac.ug"},{"id":217,"name":"Herbert Nankunda","reg":"VU-MKF-2401-0221-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 3","pct":75,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"h.nankunda@vu.ac.ug"},{"id":218,"name":"Bob Namirembe","reg":"VU-MKF-2401-0222-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 2","pct":89,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"b.namirembe@vu.ac.ug"},{"id":219,"name":"Brenda Mukasa","reg":"VU-MKF-2401-0223-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 3","pct":59,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"b.mukasa@vu.ac.ug"},{"id":220,"name":"Victor Kyeyune","reg":"VU-MKF-2401-0224-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 3","pct":94,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"v.kyeyune@vu.ac.ug"},{"id":221,"name":"Timothy Nankya","reg":"VU-MKF-2401-0225-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 3","pct":78,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"t.nankya@vu.ac.ug"},{"id":222,"name":"Lwanga Nansubuga","reg":"VU-MKF-2401-0226-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 1","pct":87,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"l.nansubuga@vu.ac.ug"},{"id":223,"name":"Herbert Nakirya","reg":"VU-MKF-2401-0227-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 2","pct":86,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"h.nakirya@vu.ac.ug"},{"id":224,"name":"Benjamin Byaruhanga","reg":"VU-MKF-2401-0228-DAY","facultyKey":"business","faculty":"Faculty of Business & Management","dept":"Marketing","deptKey":"mkt","year":"Year 1","pct":53,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"b.byaruhanga224@vu.ac.ug"},{"id":225,"name":"Ronald Ssali","reg":"VU-ENG-2401-0017-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 1","pct":null,"trend":null,"gender":"Male","semester":"Semester 1","mode":"day","email":"r.ssali@vu.ac.ug"},{"id":226,"name":"Sarah Nabukyeyo","reg":"VU-ENG-2401-0018-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 1","pct":null,"trend":null,"gender":"Female","semester":"Semester 2","mode":"day","email":"s.nabukyeyo@vu.ac.ug"},{"id":227,"name":"Timothy Wabwa","reg":"VU-ENG-2401-0019-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 2","pct":null,"trend":null,"gender":"Male","semester":"Semester 2","mode":"day","email":"t.wabwa@vu.ac.ug"},{"id":228,"name":"Winnie Nakaddwa","reg":"VU-ENG-2401-0020-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 1","pct":null,"trend":null,"gender":"Female","semester":"Semester 1","mode":"day","email":"w.nakaddwa@vu.ac.ug"},{"id":229,"name":"Faridah Nambooze","reg":"VU-CVF-2401-0229-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 3","pct":65,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"f.nambooze229@vu.ac.ug"},{"id":230,"name":"Peter Lubega","reg":"VU-CVF-2401-0230-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 3","pct":51,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"p.lubega@vu.ac.ug"},{"id":231,"name":"Zack Okello","reg":"VU-CVF-2401-0231-EVE","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 2","pct":84,"trend":"up","gender":"Male","semester":"Semester 2","mode":"evening","email":"z.okello@vu.ac.ug"},{"id":232,"name":"Cissy Nakirya","reg":"VU-CVF-2401-0232-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 3","pct":72,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"c.nakirya@vu.ac.ug"},{"id":233,"name":"Immaculate Nakirya","reg":"VU-CVF-2401-0233-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 2","pct":99,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"i.nakirya@vu.ac.ug"},{"id":234,"name":"Nelson Emmanuel","reg":"VU-CVF-2401-0234-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 2","pct":94,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"n.emmanuel@vu.ac.ug"},{"id":235,"name":"Robert Nankunda","reg":"VU-CVF-2401-0235-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 3","pct":69,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"r.nankunda@vu.ac.ug"},{"id":236,"name":"Annet Tumwesigye","reg":"VU-CVF-2401-0236-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 1","pct":71,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"a.tumwesigye@vu.ac.ug"},{"id":237,"name":"Sarah Ssebuliba","reg":"VU-CVF-2401-0237-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 3","pct":null,"trend":null,"gender":"Male","semester":"Semester 1","mode":"day","email":"s.ssebuliba@vu.ac.ug"},{"id":238,"name":"Julius Ojok","reg":"VU-CVF-2401-0238-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 1","pct":80,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"j.ojok@vu.ac.ug"},{"id":239,"name":"Tracy Kizza","reg":"VU-CVF-2401-0239-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 2","pct":77,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"t.kizza@vu.ac.ug"},{"id":240,"name":"Teddy Sarah","reg":"VU-CVF-2401-0240-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 3","pct":54,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"t.sarah@vu.ac.ug"},{"id":241,"name":"Yusuf Ssegawa","reg":"VU-CVF-2401-0241-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 2","pct":81,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"y.ssegawa@vu.ac.ug"},{"id":242,"name":"Brenda Ssegawa","reg":"VU-CVF-2401-0242-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 1","pct":90,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"b.ssegawa242@vu.ac.ug"},{"id":243,"name":"Mary Emmanuel","reg":"VU-CVF-2401-0243-EVE","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 2","pct":null,"trend":null,"gender":"Male","semester":"Semester 2","mode":"evening","email":"m.emmanuel@vu.ac.ug"},{"id":244,"name":"Gloria Nakaddwa","reg":"VU-CVF-2401-0244-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 1","pct":84,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"g.nakaddwa@vu.ac.ug"},{"id":245,"name":"Lillian Nakamya","reg":"VU-CVF-2401-0245-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 2","pct":71,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"l.nakamya@vu.ac.ug"},{"id":246,"name":"Isaac Naggayi","reg":"VU-CVF-2401-0246-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 1","pct":100,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"i.naggayi@vu.ac.ug"},{"id":247,"name":"Winnie Namirembe","reg":"VU-CVF-2401-0247-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 3","pct":null,"trend":null,"gender":"Male","semester":"Semester 2","mode":"day","email":"w.namirembe@vu.ac.ug"},{"id":248,"name":"Winnie Mukasa","reg":"VU-CVF-2401-0248-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 3","pct":95,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"w.mukasa@vu.ac.ug"},{"id":249,"name":"Rose Mbazira","reg":"VU-CVF-2401-0249-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 2","pct":100,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"r.mbazira@vu.ac.ug"},{"id":250,"name":"Doreen Ssegawa","reg":"VU-CVF-2401-0250-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 1","pct":91,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"d.ssegawa250@vu.ac.ug"},{"id":251,"name":"Brian Nakaddwa","reg":"VU-CVF-2401-0251-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 3","pct":80,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"b.nakaddwa@vu.ac.ug"},{"id":252,"name":"Frank Kabuye","reg":"VU-CVF-2401-0252-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 1","pct":70,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"f.kabuye@vu.ac.ug"},{"id":253,"name":"Brenda Kizza","reg":"VU-CVF-2401-0253-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 3","pct":79,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"b.kizza@vu.ac.ug"},{"id":254,"name":"Florence Moses","reg":"VU-CVF-2401-0254-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 3","pct":77,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"f.moses@vu.ac.ug"},{"id":255,"name":"Martin Kabuye","reg":"VU-CVF-2401-0255-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 2","pct":93,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"m.kabuye@vu.ac.ug"},{"id":256,"name":"Benjamin Namatovu","reg":"VU-CVF-2401-0256-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 3","pct":95,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"b.namatovu@vu.ac.ug"},{"id":257,"name":"Sarah Byaruhanga","reg":"VU-CVF-2401-0257-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 2","pct":93,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"s.byaruhanga@vu.ac.ug"},{"id":258,"name":"Cissy Nankya","reg":"VU-CVF-2401-0258-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 1","pct":76,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"c.nankya@vu.ac.ug"},{"id":259,"name":"Queen Nalubega","reg":"VU-CVF-2401-0259-EVE","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 3","pct":94,"trend":"down","gender":"Male","semester":"Semester 2","mode":"evening","email":"q.nalubega@vu.ac.ug"},{"id":260,"name":"Ivan Kyeyune","reg":"VU-CVF-2401-0260-EVE","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 3","pct":76,"trend":"down","gender":"Female","semester":"Semester 1","mode":"evening","email":"i.kyeyune@vu.ac.ug"},{"id":261,"name":"Nelson Mugisha","reg":"VU-CVF-2401-0261-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Civil Engineering","deptKey":"civ","year":"Year 1","pct":79,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"n.mugisha@vu.ac.ug"},{"id":262,"name":"Ronald Nakirya","reg":"VU-EEF-2401-0262-EVE","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 2","pct":60,"trend":"down","gender":"Female","semester":"Semester 2","mode":"evening","email":"r.nakirya@vu.ac.ug"},{"id":263,"name":"Carol Namboozo","reg":"VU-EEF-2401-0263-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 1","pct":91,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"c.namboozo263@vu.ac.ug"},{"id":264,"name":"Damalie Otim","reg":"VU-EEF-2401-0264-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 2","pct":96,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"d.otim@vu.ac.ug"},{"id":265,"name":"Umar Mugisha","reg":"VU-EEF-2401-0265-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 2","pct":61,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"u.mugisha@vu.ac.ug"},{"id":266,"name":"Gertrude Wabwa","reg":"VU-EEF-2401-0266-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 2","pct":94,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"g.wabwa@vu.ac.ug"},{"id":267,"name":"Zainab Kibirige","reg":"VU-EEF-2401-0267-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 3","pct":84,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"z.kibirige@vu.ac.ug"},{"id":268,"name":"Patience Bbosa","reg":"VU-EEF-2401-0268-EVE","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 3","pct":87,"trend":"up","gender":"Female","semester":"Semester 1","mode":"evening","email":"p.bbosa268@vu.ac.ug"},{"id":269,"name":"Patience Nankunda","reg":"VU-EEF-2401-0269-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 3","pct":96,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"p.nankunda269@vu.ac.ug"},{"id":270,"name":"Walter Nankunda","reg":"VU-EEF-2401-0270-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 2","pct":null,"trend":null,"gender":"Female","semester":"Semester 2","mode":"day","email":"w.nankunda@vu.ac.ug"},{"id":271,"name":"Tracy Moses","reg":"VU-EEF-2401-0271-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 1","pct":81,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"t.moses@vu.ac.ug"},{"id":272,"name":"Winnie Wabwa","reg":"VU-EEF-2401-0272-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 1","pct":98,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"w.wabwa@vu.ac.ug"},{"id":273,"name":"Yusuf Akwango","reg":"VU-EEF-2401-0273-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 3","pct":80,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"y.akwango273@vu.ac.ug"},{"id":274,"name":"Collins Tushabe","reg":"VU-EEF-2401-0274-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 3","pct":72,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"c.tushabe@vu.ac.ug"},{"id":275,"name":"Mary Atim","reg":"VU-EEF-2401-0275-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 2","pct":89,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"m.atim@vu.ac.ug"},{"id":276,"name":"Kelvin Nambooze","reg":"VU-EEF-2401-0276-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 2","pct":100,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"k.nambooze@vu.ac.ug"},{"id":277,"name":"Edith Otim","reg":"VU-EEF-2401-0277-EVE","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 3","pct":89,"trend":"up","gender":"Male","semester":"Semester 1","mode":"evening","email":"e.otim@vu.ac.ug"},{"id":278,"name":"Nathan Okwir","reg":"VU-EEF-2401-0278-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 3","pct":81,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"n.okwir@vu.ac.ug"},{"id":279,"name":"Walter Byaruhanga","reg":"VU-EEF-2401-0279-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 2","pct":56,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"w.byaruhanga279@vu.ac.ug"},{"id":280,"name":"Lillian Wabwa","reg":"VU-EEF-2401-0280-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 1","pct":91,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"l.wabwa@vu.ac.ug"},{"id":281,"name":"Lwanga Kibirige","reg":"VU-EEF-2401-0281-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 1","pct":75,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"l.kibirige@vu.ac.ug"},{"id":282,"name":"Nabaale Namirembe","reg":"VU-EEF-2401-0282-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 3","pct":77,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"n.namirembe@vu.ac.ug"},{"id":283,"name":"Immaculate Ssemwanga","reg":"VU-EEF-2401-0283-EVE","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 2","pct":95,"trend":"up","gender":"Male","semester":"Semester 2","mode":"evening","email":"i.ssemwanga@vu.ac.ug"},{"id":284,"name":"Stella Namukasa","reg":"VU-EEF-2401-0284-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 1","pct":97,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"s.namukasa@vu.ac.ug"},{"id":285,"name":"Leo Naggayi","reg":"VU-EEF-2401-0285-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 2","pct":null,"trend":null,"gender":"Male","semester":"Semester 1","mode":"day","email":"l.naggayi@vu.ac.ug"},{"id":286,"name":"Brenda Ssemwanga","reg":"VU-EEF-2401-0286-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 2","pct":74,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"b.ssemwanga286@vu.ac.ug"},{"id":287,"name":"Henry Ssegawa","reg":"VU-EEF-2401-0287-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 1","pct":78,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"h.ssegawa@vu.ac.ug"},{"id":288,"name":"Kevin Atim","reg":"VU-EEF-2401-0288-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 3","pct":78,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"k.atim@vu.ac.ug"},{"id":289,"name":"Quincy Achieng","reg":"VU-EEF-2401-0289-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 1","pct":97,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"q.achieng@vu.ac.ug"},{"id":290,"name":"Rose Ssegawa","reg":"VU-EEF-2401-0290-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 1","pct":88,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"r.ssegawa@vu.ac.ug"},{"id":291,"name":"Zack Nankunda","reg":"VU-EEF-2401-0291-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 1","pct":91,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"z.nankunda@vu.ac.ug"},{"id":292,"name":"Gertrude Byaruhanga","reg":"VU-EEF-2401-0292-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 1","pct":83,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"g.byaruhanga@vu.ac.ug"},{"id":293,"name":"Cissy Nalubega","reg":"VU-EEF-2401-0293-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 2","pct":78,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"c.nalubega@vu.ac.ug"},{"id":294,"name":"Rachel Namboozo","reg":"VU-EEF-2401-0294-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 2","pct":80,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"r.namboozo@vu.ac.ug"},{"id":295,"name":"Dennis Byaruhanga","reg":"VU-EEF-2401-0295-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 3","pct":72,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"d.byaruhanga@vu.ac.ug"},{"id":296,"name":"Irene Wabwa","reg":"VU-EEF-2401-0296-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 1","pct":65,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"i.wabwa296@vu.ac.ug"},{"id":297,"name":"Viola Nakaddwa","reg":"VU-EEF-2401-0297-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 3","pct":90,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"v.nakaddwa@vu.ac.ug"},{"id":298,"name":"Irene Okello","reg":"VU-EEF-2401-0298-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Electrical Engineering","deptKey":"eee","year":"Year 3","pct":99,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"i.okello@vu.ac.ug"},{"id":299,"name":"Xavier Akwango","reg":"VU-MEF-2401-0299-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 2","pct":87,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"x.akwango@vu.ac.ug"},{"id":300,"name":"Gertrude Akwango","reg":"VU-MEF-2401-0300-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 1","pct":100,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"g.akwango@vu.ac.ug"},{"id":301,"name":"Joseph Kibirige","reg":"VU-MEF-2401-0301-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 2","pct":92,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"j.kibirige301@vu.ac.ug"},{"id":302,"name":"Yvonne Nakirya","reg":"VU-MEF-2401-0302-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 1","pct":89,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"y.nakirya@vu.ac.ug"},{"id":303,"name":"Betty Wasswa","reg":"VU-MEF-2401-0303-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 2","pct":null,"trend":null,"gender":"Male","semester":"Semester 2","mode":"day","email":"b.wasswa@vu.ac.ug"},{"id":304,"name":"Cissy Nantongo","reg":"VU-MEF-2401-0304-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 2","pct":76,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"c.nantongo@vu.ac.ug"},{"id":305,"name":"Zack Kabuye","reg":"VU-MEF-2401-0305-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 2","pct":96,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"z.kabuye@vu.ac.ug"},{"id":306,"name":"Grace Ssebuliba","reg":"VU-MEF-2401-0306-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 3","pct":79,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"g.ssebuliba@vu.ac.ug"},{"id":307,"name":"Kevin Tushabe","reg":"VU-MEF-2401-0307-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 3","pct":93,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"k.tushabe@vu.ac.ug"},{"id":308,"name":"Robert Ssebuliba","reg":"VU-MEF-2401-0308-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 3","pct":89,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"r.ssebuliba308@vu.ac.ug"},{"id":309,"name":"Nelson Namukasa","reg":"VU-MEF-2401-0309-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 3","pct":83,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"n.namukasa@vu.ac.ug"},{"id":310,"name":"Joan Ssemwanga","reg":"VU-MEF-2401-0310-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 3","pct":92,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"j.ssemwanga@vu.ac.ug"},{"id":311,"name":"Norah Tushabe","reg":"VU-MEF-2401-0311-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 2","pct":74,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"n.tushabe@vu.ac.ug"},{"id":312,"name":"Queen Wasswa","reg":"VU-MEF-2401-0312-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 2","pct":66,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"q.wasswa@vu.ac.ug"},{"id":313,"name":"Ronald Moses","reg":"VU-MEF-2401-0313-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 3","pct":61,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"r.moses@vu.ac.ug"},{"id":314,"name":"Viola Nankunda","reg":"VU-MEF-2401-0314-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 2","pct":84,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"v.nankunda@vu.ac.ug"},{"id":315,"name":"Agnes Naggayi","reg":"VU-MEF-2401-0315-EVE","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 3","pct":100,"trend":"up","gender":"Male","semester":"Semester 2","mode":"evening","email":"a.naggayi@vu.ac.ug"},{"id":316,"name":"Frank Emmanuel","reg":"VU-MEF-2401-0316-EVE","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 1","pct":82,"trend":"down","gender":"Female","semester":"Semester 1","mode":"evening","email":"f.emmanuel@vu.ac.ug"},{"id":317,"name":"Grace Otim","reg":"VU-MEF-2401-0317-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 3","pct":92,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"g.otim@vu.ac.ug"},{"id":318,"name":"Simon Kibirige","reg":"VU-MEF-2401-0318-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 1","pct":98,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"s.kibirige@vu.ac.ug"},{"id":319,"name":"Henry Atim","reg":"VU-MEF-2401-0319-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 2","pct":50,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"h.atim@vu.ac.ug"},{"id":320,"name":"Walter Nalubega","reg":"VU-MEF-2401-0320-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 2","pct":79,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"w.nalubega@vu.ac.ug"},{"id":321,"name":"Martin Namukasa","reg":"VU-MEF-2401-0321-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 2","pct":78,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"m.namukasa@vu.ac.ug"},{"id":322,"name":"Susan Sarah","reg":"VU-MEF-2401-0322-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 1","pct":86,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"s.sarah@vu.ac.ug"},{"id":323,"name":"Brenda Ssali","reg":"VU-MEF-2401-0323-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 1","pct":79,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"b.ssali323@vu.ac.ug"},{"id":324,"name":"Simon Achieng","reg":"VU-MEF-2401-0324-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 1","pct":74,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"s.achieng@vu.ac.ug"},{"id":325,"name":"Yusuf Nantongo","reg":"VU-MEF-2401-0325-EVE","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 3","pct":93,"trend":"up","gender":"Male","semester":"Semester 1","mode":"evening","email":"y.nantongo@vu.ac.ug"},{"id":326,"name":"Mary Mugisha","reg":"VU-MEF-2401-0326-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 3","pct":74,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"m.mugisha326@vu.ac.ug"},{"id":327,"name":"Hassan Nantongo","reg":"VU-MEF-2401-0327-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 3","pct":92,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"h.nantongo@vu.ac.ug"},{"id":328,"name":"Walter Nakaddwa","reg":"VU-MEF-2401-0328-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 2","pct":87,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"w.nakaddwa328@vu.ac.ug"},{"id":329,"name":"Timothy Nalubega","reg":"VU-MEF-2401-0329-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 3","pct":90,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"t.nalubega@vu.ac.ug"},{"id":330,"name":"Gloria Akwango","reg":"VU-MEF-2401-0330-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 3","pct":85,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"g.akwango330@vu.ac.ug"},{"id":331,"name":"David Namukasa","reg":"VU-MEF-2401-0331-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 2","pct":47,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"d.namukasa331@vu.ac.ug"},{"id":332,"name":"Ivan Mbazira","reg":"VU-MEF-2401-0332-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 2","pct":65,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"i.mbazira332@vu.ac.ug"},{"id":333,"name":"Rose Okwir","reg":"VU-MEF-2401-0333-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 3","pct":80,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"r.okwir@vu.ac.ug"},{"id":334,"name":"Nelson Kizza","reg":"VU-MEF-2401-0334-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 2","pct":73,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"n.kizza@vu.ac.ug"},{"id":335,"name":"Ivan Kasule","reg":"VU-MEF-2401-0335-DAY","facultyKey":"engineering","faculty":"Faculty of Engineering","dept":"Mechanical Engineering","deptKey":"mech","year":"Year 2","pct":52,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"i.kasule@vu.ac.ug"},{"id":336,"name":"Emmanuel Wamala","reg":"VU-BIF-2401-0336-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 1","pct":76,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"e.wamala@vu.ac.ug"},{"id":337,"name":"Daniel Bbosa","reg":"VU-BIF-2401-0337-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 3","pct":75,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"d.bbosa@vu.ac.ug"},{"id":338,"name":"Lwanga Namukasa","reg":"VU-BIF-2401-0338-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 2","pct":86,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"l.namukasa@vu.ac.ug"},{"id":339,"name":"Michael Lubega","reg":"VU-BIF-2401-0339-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 1","pct":87,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"m.lubega@vu.ac.ug"},{"id":340,"name":"Leo Lubega","reg":"VU-BIF-2401-0340-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 2","pct":94,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"l.lubega340@vu.ac.ug"},{"id":341,"name":"Patience Nakirya","reg":"VU-BIF-2401-0341-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 2","pct":92,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"p.nakirya@vu.ac.ug"},{"id":342,"name":"Kelvin Ssebuliba","reg":"VU-BIF-2401-0342-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 1","pct":76,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"k.ssebuliba@vu.ac.ug"},{"id":343,"name":"Felix Akwango","reg":"VU-BIF-2401-0343-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 2","pct":73,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"f.akwango@vu.ac.ug"},{"id":344,"name":"Rachel Mukasa","reg":"VU-BIF-2401-0344-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 3","pct":94,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"r.mukasa@vu.ac.ug"},{"id":345,"name":"Peter Akwango","reg":"VU-BIF-2401-0345-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 3","pct":97,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"p.akwango@vu.ac.ug"},{"id":346,"name":"Alex Ssemwanga","reg":"VU-BIF-2401-0346-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 2","pct":53,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"a.ssemwanga@vu.ac.ug"},{"id":347,"name":"Oscar Nakaddwa","reg":"VU-BIF-2401-0347-EVE","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 3","pct":94,"trend":"down","gender":"Male","semester":"Semester 2","mode":"evening","email":"o.nakaddwa@vu.ac.ug"},{"id":348,"name":"Norah Mugisha","reg":"VU-BIF-2401-0348-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 3","pct":93,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"n.mugisha348@vu.ac.ug"},{"id":349,"name":"Betty Ojok","reg":"VU-BIF-2401-0349-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 3","pct":87,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"b.ojok@vu.ac.ug"},{"id":350,"name":"Benjamin Namutebi","reg":"VU-BIF-2401-0350-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 1","pct":81,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"b.namutebi350@vu.ac.ug"},{"id":351,"name":"Opio Mukasa","reg":"VU-BIF-2401-0351-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 2","pct":88,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"o.mukasa@vu.ac.ug"},{"id":352,"name":"Isaiah Kizza","reg":"VU-BIF-2401-0352-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 1","pct":92,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"i.kizza@vu.ac.ug"},{"id":353,"name":"Yusuf Byaruhanga","reg":"VU-BIF-2401-0353-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 3","pct":89,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"y.byaruhanga@vu.ac.ug"},{"id":354,"name":"James Tumwesigye","reg":"VU-BIF-2401-0354-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 3","pct":95,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"j.tumwesigye@vu.ac.ug"},{"id":355,"name":"Simon Byaruhanga","reg":"VU-BIF-2401-0355-EVE","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 1","pct":84,"trend":"up","gender":"Male","semester":"Semester 2","mode":"evening","email":"s.byaruhanga355@vu.ac.ug"},{"id":356,"name":"Susan Tushabe","reg":"VU-BIF-2401-0356-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 2","pct":90,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"s.tushabe@vu.ac.ug"},{"id":357,"name":"Bob Tumwesigye","reg":"VU-BIF-2401-0357-EVE","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 3","pct":83,"trend":"up","gender":"Male","semester":"Semester 1","mode":"evening","email":"b.tumwesigye@vu.ac.ug"},{"id":358,"name":"Lillian Namatovu","reg":"VU-BIF-2401-0358-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 3","pct":87,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"l.namatovu358@vu.ac.ug"},{"id":359,"name":"Martin Ssebuliba","reg":"VU-BIF-2401-0359-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 2","pct":77,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"m.ssebuliba@vu.ac.ug"},{"id":360,"name":"Opio Mugisha","reg":"VU-BIF-2401-0360-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 2","pct":73,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"o.mugisha@vu.ac.ug"},{"id":361,"name":"Olivia Lubega","reg":"VU-BIF-2401-0361-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 3","pct":63,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"o.lubega@vu.ac.ug"},{"id":362,"name":"Peter Namutebi","reg":"VU-BIF-2401-0362-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 1","pct":82,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"p.namutebi362@vu.ac.ug"},{"id":363,"name":"Nabaale Nakirya","reg":"VU-BIF-2401-0363-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 2","pct":96,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"n.nakirya@vu.ac.ug"},{"id":364,"name":"Aisha Lubega","reg":"VU-BIF-2401-0364-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 1","pct":90,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"a.lubega364@vu.ac.ug"},{"id":365,"name":"Xavier Tendo","reg":"VU-BIF-2401-0365-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 2","pct":99,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"x.tendo@vu.ac.ug"},{"id":366,"name":"Xavier Namatovu","reg":"VU-BIF-2401-0366-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 1","pct":76,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"x.namatovu@vu.ac.ug"},{"id":367,"name":"Hassan Moses","reg":"VU-BIF-2401-0367-EVE","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 1","pct":90,"trend":"up","gender":"Male","semester":"Semester 2","mode":"evening","email":"h.moses@vu.ac.ug"},{"id":368,"name":"Julius Wabwa","reg":"VU-BIF-2401-0368-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 1","pct":78,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"j.wabwa368@vu.ac.ug"},{"id":369,"name":"Queen Wamala","reg":"VU-BIF-2401-0369-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 3","pct":79,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"q.wamala@vu.ac.ug"},{"id":370,"name":"Olivia Tendo","reg":"VU-BIF-2401-0370-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 1","pct":95,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"o.tendo@vu.ac.ug"},{"id":371,"name":"Felix Moses","reg":"VU-BIF-2401-0371-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 1","pct":93,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"f.moses371@vu.ac.ug"},{"id":372,"name":"Carol Nantongo","reg":"VU-BIF-2401-0372-EVE","facultyKey":"science","faculty":"Faculty of Science","dept":"Biology","deptKey":"bio","year":"Year 3","pct":91,"trend":"up","gender":"Female","semester":"Semester 1","mode":"evening","email":"c.nantongo372@vu.ac.ug"},{"id":373,"name":"Doreen Namirembe","reg":"VU-CHF-2401-0373-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 3","pct":90,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"d.namirembe@vu.ac.ug"},{"id":374,"name":"Linda Nakamya","reg":"VU-CHF-2401-0374-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 2","pct":83,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"l.nakamya374@vu.ac.ug"},{"id":375,"name":"Susan Kyeyune","reg":"VU-CHF-2401-0375-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 3","pct":86,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"s.kyeyune@vu.ac.ug"},{"id":376,"name":"Prossy Nankunda","reg":"VU-CHF-2401-0376-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 1","pct":73,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"p.nankunda376@vu.ac.ug"},{"id":377,"name":"Eric Tushabe","reg":"VU-CHF-2401-0377-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 2","pct":84,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"e.tushabe@vu.ac.ug"},{"id":378,"name":"Immaculate Namukasa","reg":"VU-CHF-2401-0378-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 2","pct":94,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"i.namukasa378@vu.ac.ug"},{"id":379,"name":"Hassan Wasswa","reg":"VU-CHF-2401-0379-EVE","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 3","pct":100,"trend":"up","gender":"Male","semester":"Semester 2","mode":"evening","email":"h.wasswa@vu.ac.ug"},{"id":380,"name":"Leo Namutebi","reg":"VU-CHF-2401-0380-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 3","pct":77,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"l.namutebi380@vu.ac.ug"},{"id":381,"name":"Henry Naggayi","reg":"VU-CHF-2401-0381-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 2","pct":76,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"h.naggayi@vu.ac.ug"},{"id":382,"name":"Nelson Achieng","reg":"VU-CHF-2401-0382-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 1","pct":89,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"n.achieng@vu.ac.ug"},{"id":383,"name":"Benjamin Annet","reg":"VU-CHF-2401-0383-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 3","pct":56,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"b.annet@vu.ac.ug"},{"id":384,"name":"Ronald Kiggundu","reg":"VU-CHF-2401-0384-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 2","pct":93,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"r.kiggundu@vu.ac.ug"},{"id":385,"name":"Lawrence Wamala","reg":"VU-CHF-2401-0385-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 3","pct":87,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"l.wamala385@vu.ac.ug"},{"id":386,"name":"Aisha Nambooze","reg":"VU-CHF-2401-0386-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 1","pct":null,"trend":null,"gender":"Female","semester":"Semester 2","mode":"day","email":"a.nambooze386@vu.ac.ug"},{"id":387,"name":"Brenda Wasswa","reg":"VU-CHF-2401-0387-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 1","pct":42,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"b.wasswa387@vu.ac.ug"},{"id":388,"name":"Alex Namboozo","reg":"VU-CHF-2401-0388-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 2","pct":99,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"a.namboozo@vu.ac.ug"},{"id":389,"name":"Eve Okwir","reg":"VU-CHF-2401-0389-EVE","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 2","pct":87,"trend":"up","gender":"Male","semester":"Semester 1","mode":"evening","email":"e.okwir@vu.ac.ug"},{"id":390,"name":"Benjamin Nankunda","reg":"VU-CHF-2401-0390-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 3","pct":78,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"b.nankunda@vu.ac.ug"},{"id":391,"name":"Isaac Namirembe","reg":"VU-CHF-2401-0391-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 3","pct":75,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"i.namirembe@vu.ac.ug"},{"id":392,"name":"Susan Wamala","reg":"VU-CHF-2401-0392-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 3","pct":87,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"s.wamala@vu.ac.ug"},{"id":393,"name":"Brenda Ssebuliba","reg":"VU-CHF-2401-0393-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 2","pct":99,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"b.ssebuliba@vu.ac.ug"},{"id":394,"name":"Irene Nankunda","reg":"VU-CHF-2401-0394-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 2","pct":75,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"i.nankunda394@vu.ac.ug"},{"id":395,"name":"Gloria Nalubega","reg":"VU-CHF-2401-0395-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 1","pct":96,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"g.nalubega@vu.ac.ug"},{"id":396,"name":"Linda Nambooze","reg":"VU-CHF-2401-0396-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 1","pct":81,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"l.nambooze@vu.ac.ug"},{"id":397,"name":"Rachel Nankya","reg":"VU-CHF-2401-0397-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 2","pct":93,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"r.nankya@vu.ac.ug"},{"id":398,"name":"Nelson Bbosa","reg":"VU-CHF-2401-0398-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 3","pct":79,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"n.bbosa@vu.ac.ug"},{"id":399,"name":"Fred Nakaddwa","reg":"VU-CHF-2401-0399-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 2","pct":98,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"f.nakaddwa399@vu.ac.ug"},{"id":400,"name":"Umar Apio","reg":"VU-CHF-2401-0400-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 2","pct":null,"trend":null,"gender":"Female","semester":"Semester 1","mode":"day","email":"u.apio@vu.ac.ug"},{"id":401,"name":"Henry Mukasa","reg":"VU-CHF-2401-0401-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 3","pct":71,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"h.mukasa@vu.ac.ug"},{"id":402,"name":"Diana Okello","reg":"VU-CHF-2401-0402-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 3","pct":84,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"d.okello402@vu.ac.ug"},{"id":403,"name":"Ivan Kiggundu","reg":"VU-CHF-2401-0403-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 3","pct":91,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"i.kiggundu@vu.ac.ug"},{"id":404,"name":"Gertrude Namutebi","reg":"VU-CHF-2401-0404-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 2","pct":89,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"g.namutebi@vu.ac.ug"},{"id":405,"name":"Doreen Achieng","reg":"VU-CHF-2401-0405-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 3","pct":null,"trend":null,"gender":"Male","semester":"Semester 1","mode":"day","email":"d.achieng@vu.ac.ug"},{"id":406,"name":"Faith Apio","reg":"VU-CHF-2401-0406-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 3","pct":81,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"f.apio@vu.ac.ug"},{"id":407,"name":"Bob Annet","reg":"VU-CHF-2401-0407-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 2","pct":81,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"b.annet407@vu.ac.ug"},{"id":408,"name":"Isaiah Mbazira","reg":"VU-CHF-2401-0408-EVE","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 3","pct":82,"trend":"up","gender":"Female","semester":"Semester 1","mode":"evening","email":"i.mbazira408@vu.ac.ug"},{"id":409,"name":"Brian Namutebi","reg":"VU-CHF-2401-0409-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Chemistry","deptKey":"chem","year":"Year 3","pct":89,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"b.namutebi409@vu.ac.ug"},{"id":410,"name":"Tracy Ssali","reg":"VU-MSF-2401-0410-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 2","pct":78,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"t.ssali@vu.ac.ug"},{"id":411,"name":"Leo Mukasa","reg":"VU-MSF-2401-0411-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 1","pct":93,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"l.mukasa@vu.ac.ug"},{"id":412,"name":"Isaiah Ssebuliba","reg":"VU-MSF-2401-0412-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 1","pct":93,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"i.ssebuliba@vu.ac.ug"},{"id":413,"name":"Rose Ssebuliba","reg":"VU-MSF-2401-0413-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 1","pct":82,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"r.ssebuliba413@vu.ac.ug"},{"id":414,"name":"Kenneth Mugisha","reg":"VU-MSF-2401-0414-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 3","pct":90,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"k.mugisha@vu.ac.ug"},{"id":415,"name":"Timothy Sarah","reg":"VU-MSF-2401-0415-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 3","pct":73,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"t.sarah415@vu.ac.ug"},{"id":416,"name":"Charles Moses","reg":"VU-MSF-2401-0416-EVE","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 3","pct":91,"trend":"up","gender":"Female","semester":"Semester 1","mode":"evening","email":"c.moses@vu.ac.ug"},{"id":417,"name":"Winnie Nankunda","reg":"VU-MSF-2401-0417-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 1","pct":95,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"w.nankunda417@vu.ac.ug"},{"id":418,"name":"Sarah Naggayi","reg":"VU-MSF-2401-0418-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 1","pct":86,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"s.naggayi@vu.ac.ug"},{"id":419,"name":"Tom Kabuye","reg":"VU-MSF-2401-0419-EVE","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 3","pct":96,"trend":"down","gender":"Male","semester":"Semester 2","mode":"evening","email":"t.kabuye@vu.ac.ug"},{"id":420,"name":"Esther Nakamya","reg":"VU-MSF-2401-0420-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 3","pct":null,"trend":null,"gender":"Female","semester":"Semester 1","mode":"day","email":"e.nakamya@vu.ac.ug"},{"id":421,"name":"Henry Kizza","reg":"VU-MSF-2401-0421-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 2","pct":91,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"h.kizza@vu.ac.ug"},{"id":422,"name":"Carol Nakirya","reg":"VU-MSF-2401-0422-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 1","pct":94,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"c.nakirya422@vu.ac.ug"},{"id":423,"name":"Cissy Nabukyeyo","reg":"VU-MSF-2401-0423-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 2","pct":89,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"c.nabukyeyo@vu.ac.ug"},{"id":424,"name":"Dennis Emmanuel","reg":"VU-MSF-2401-0424-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 2","pct":95,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"d.emmanuel424@vu.ac.ug"},{"id":425,"name":"Faith Okwir","reg":"VU-MSF-2401-0425-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 3","pct":97,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"f.okwir425@vu.ac.ug"},{"id":426,"name":"Brenda Kasule","reg":"VU-MSF-2401-0426-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 2","pct":78,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"b.kasule@vu.ac.ug"},{"id":427,"name":"Janet Annet","reg":"VU-MSF-2401-0427-EVE","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 3","pct":76,"trend":"up","gender":"Male","semester":"Semester 2","mode":"evening","email":"j.annet@vu.ac.ug"},{"id":428,"name":"Benjamin Nabukyeyo","reg":"VU-MSF-2401-0428-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 3","pct":null,"trend":null,"gender":"Female","semester":"Semester 1","mode":"day","email":"b.nabukyeyo@vu.ac.ug"},{"id":429,"name":"Viola Ssemwanga","reg":"VU-MSF-2401-0429-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 1","pct":97,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"v.ssemwanga@vu.ac.ug"},{"id":430,"name":"Agnes Namatovu","reg":"VU-MSF-2401-0430-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 1","pct":96,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"a.namatovu@vu.ac.ug"},{"id":431,"name":"Gertrude Okello","reg":"VU-MSF-2401-0431-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 3","pct":98,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"g.okello@vu.ac.ug"},{"id":432,"name":"Emmanuel Nambooze","reg":"VU-MSF-2401-0432-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 2","pct":77,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"e.nambooze@vu.ac.ug"},{"id":433,"name":"Robert Tushabe","reg":"VU-MSF-2401-0433-EVE","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 3","pct":99,"trend":"up","gender":"Male","semester":"Semester 1","mode":"evening","email":"r.tushabe@vu.ac.ug"},{"id":434,"name":"Grace Kabuye","reg":"VU-MSF-2401-0434-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 2","pct":82,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"g.kabuye@vu.ac.ug"},{"id":435,"name":"Kenneth Okwir","reg":"VU-MSF-2401-0435-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 2","pct":87,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"k.okwir@vu.ac.ug"},{"id":436,"name":"Martin Nantongo","reg":"VU-MSF-2401-0436-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 2","pct":77,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"m.nantongo@vu.ac.ug"},{"id":437,"name":"Teddy Okwir","reg":"VU-MSF-2401-0437-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 3","pct":71,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"t.okwir@vu.ac.ug"},{"id":438,"name":"Viola Otim","reg":"VU-MSF-2401-0438-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 1","pct":89,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"v.otim438@vu.ac.ug"},{"id":439,"name":"Leo Nabukyeyo","reg":"VU-MSF-2401-0439-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 1","pct":72,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"l.nabukyeyo@vu.ac.ug"},{"id":440,"name":"Lawrence Lubega","reg":"VU-MSF-2401-0440-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 3","pct":null,"trend":null,"gender":"Female","semester":"Semester 1","mode":"day","email":"l.lubega440@vu.ac.ug"},{"id":441,"name":"Cissy Lubega","reg":"VU-MSF-2401-0441-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 1","pct":87,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"c.lubega@vu.ac.ug"},{"id":442,"name":"Rose Atim","reg":"VU-MSF-2401-0442-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 2","pct":92,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"r.atim@vu.ac.ug"},{"id":443,"name":"Nelson Ojok","reg":"VU-MSF-2401-0443-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 1","pct":69,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"n.ojok@vu.ac.ug"},{"id":444,"name":"Susan Nabukyeyo","reg":"VU-MSF-2401-0444-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 2","pct":69,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"s.nabukyeyo444@vu.ac.ug"},{"id":445,"name":"Hassan Nakaddwa","reg":"VU-MSF-2401-0445-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 2","pct":82,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"h.nakaddwa@vu.ac.ug"},{"id":446,"name":"Quincy Nantongo","reg":"VU-MSF-2401-0446-DAY","facultyKey":"science","faculty":"Faculty of Science","dept":"Mathematics & Statistics","deptKey":"math","year":"Year 1","pct":65,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"q.nantongo@vu.ac.ug"},{"id":447,"name":"Brian Akwango","reg":"VU-EDF-2401-0447-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 3","pct":89,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"b.akwango@vu.ac.ug"},{"id":448,"name":"Lwanga Mugisha","reg":"VU-EDF-2401-0448-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 3","pct":97,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"l.mugisha@vu.ac.ug"},{"id":449,"name":"Bob Mukasa","reg":"VU-EDF-2401-0449-EVE","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 1","pct":84,"trend":"down","gender":"Male","semester":"Semester 1","mode":"evening","email":"b.mukasa449@vu.ac.ug"},{"id":450,"name":"Nelson Namutebi","reg":"VU-EDF-2401-0450-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 2","pct":87,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"n.namutebi@vu.ac.ug"},{"id":451,"name":"Joan Namatovu","reg":"VU-EDF-2401-0451-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 1","pct":96,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"j.namatovu@vu.ac.ug"},{"id":452,"name":"Herbert Wamala","reg":"VU-EDF-2401-0452-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 3","pct":97,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"h.wamala452@vu.ac.ug"},{"id":453,"name":"Fred Apio","reg":"VU-EDF-2401-0453-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 2","pct":83,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"f.apio453@vu.ac.ug"},{"id":454,"name":"Felix Ssegawa","reg":"VU-EDF-2401-0454-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 2","pct":90,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"f.ssegawa@vu.ac.ug"},{"id":455,"name":"Isaac Nankya","reg":"VU-EDF-2401-0455-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 3","pct":null,"trend":null,"gender":"Male","semester":"Semester 2","mode":"day","email":"i.nankya@vu.ac.ug"},{"id":456,"name":"Damalie Wasswa","reg":"VU-EDF-2401-0456-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 3","pct":78,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"d.wasswa@vu.ac.ug"},{"id":457,"name":"Yusuf Nankunda","reg":"VU-EDF-2401-0457-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 2","pct":93,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"y.nankunda457@vu.ac.ug"},{"id":458,"name":"Kelvin Akwango","reg":"VU-EDF-2401-0458-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 2","pct":47,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"k.akwango@vu.ac.ug"},{"id":459,"name":"George Lubega","reg":"VU-EDF-2401-0459-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 3","pct":86,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"g.lubega@vu.ac.ug"},{"id":460,"name":"Ivan Tushabe","reg":"VU-EDF-2401-0460-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 3","pct":86,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"i.tushabe@vu.ac.ug"},{"id":461,"name":"Bob Nakirya","reg":"VU-EDF-2401-0461-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 2","pct":78,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"b.nakirya@vu.ac.ug"},{"id":462,"name":"Brenda Nakaddwa","reg":"VU-EDF-2401-0462-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 2","pct":72,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"b.nakaddwa462@vu.ac.ug"},{"id":463,"name":"Faridah Nansubuga","reg":"VU-EDF-2401-0463-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 3","pct":84,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"f.nansubuga@vu.ac.ug"},{"id":464,"name":"Eric Mbazira","reg":"VU-EDF-2401-0464-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 1","pct":96,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"e.mbazira@vu.ac.ug"},{"id":465,"name":"Isaiah Namutebi","reg":"VU-EDF-2401-0465-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 3","pct":73,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"i.namutebi@vu.ac.ug"},{"id":466,"name":"Joseph Wamala","reg":"VU-EDF-2401-0466-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 1","pct":80,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"j.wamala@vu.ac.ug"},{"id":467,"name":"Isaiah Nantongo","reg":"VU-EDF-2401-0467-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 1","pct":75,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"i.nantongo@vu.ac.ug"},{"id":468,"name":"Gloria Nabukyeyo","reg":"VU-EDF-2401-0468-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 3","pct":43,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"g.nabukyeyo@vu.ac.ug"},{"id":469,"name":"Isaac Moses","reg":"VU-EDF-2401-0469-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 2","pct":83,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"i.moses@vu.ac.ug"},{"id":470,"name":"Henry Kabuye","reg":"VU-EDF-2401-0470-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 2","pct":93,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"h.kabuye@vu.ac.ug"},{"id":471,"name":"Brenda Tumwesigye","reg":"VU-EDF-2401-0471-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 2","pct":97,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"b.tumwesigye471@vu.ac.ug"},{"id":472,"name":"Simon Kyeyune","reg":"VU-EDF-2401-0472-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 1","pct":82,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"s.kyeyune472@vu.ac.ug"},{"id":473,"name":"Joan Moses","reg":"VU-EDF-2401-0473-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 2","pct":88,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"j.moses@vu.ac.ug"},{"id":474,"name":"Nelson Okwir","reg":"VU-EDF-2401-0474-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 2","pct":97,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"n.okwir474@vu.ac.ug"},{"id":475,"name":"Lawrence Sarah","reg":"VU-EDF-2401-0475-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 2","pct":72,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"l.sarah475@vu.ac.ug"},{"id":476,"name":"Tom Kiggundu","reg":"VU-EDF-2401-0476-EVE","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 2","pct":81,"trend":"down","gender":"Female","semester":"Semester 1","mode":"evening","email":"t.kiggundu@vu.ac.ug"},{"id":477,"name":"Lawrence Nankya","reg":"VU-EDF-2401-0477-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 3","pct":88,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"l.nankya@vu.ac.ug"},{"id":478,"name":"Charles Sarah","reg":"VU-EDF-2401-0478-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 1","pct":82,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"c.sarah@vu.ac.ug"},{"id":479,"name":"Irene Nabukyeyo","reg":"VU-EDF-2401-0479-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 1","pct":72,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"i.nabukyeyo479@vu.ac.ug"},{"id":480,"name":"Michael Nambooze","reg":"VU-EDF-2401-0480-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 2","pct":43,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"m.nambooze@vu.ac.ug"},{"id":481,"name":"Olivia Tushabe","reg":"VU-EDF-2401-0481-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 3","pct":99,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"o.tushabe@vu.ac.ug"},{"id":482,"name":"Leo Kizza","reg":"VU-EDF-2401-0482-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 2","pct":78,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"l.kizza482@vu.ac.ug"},{"id":483,"name":"Susan Namboozo","reg":"VU-EDF-2401-0483-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Education","deptKey":"edu","year":"Year 2","pct":77,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"s.namboozo@vu.ac.ug"},{"id":484,"name":"Lillian Tushabe","reg":"VU-MCF-2401-0484-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 1","pct":97,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"l.tushabe@vu.ac.ug"},{"id":485,"name":"Eric Nantongo","reg":"VU-MCF-2401-0485-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 3","pct":100,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"e.nantongo485@vu.ac.ug"},{"id":486,"name":"Gloria Kiggundu","reg":"VU-MCF-2401-0486-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 3","pct":92,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"g.kiggundu@vu.ac.ug"},{"id":487,"name":"Yvonne Naggayi","reg":"VU-MCF-2401-0487-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 2","pct":91,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"y.naggayi@vu.ac.ug"},{"id":488,"name":"Rachel Okello","reg":"VU-MCF-2401-0488-EVE","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 2","pct":95,"trend":"up","gender":"Female","semester":"Semester 1","mode":"evening","email":"r.okello@vu.ac.ug"},{"id":489,"name":"Linda Ssebuliba","reg":"VU-MCF-2401-0489-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 3","pct":96,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"l.ssebuliba@vu.ac.ug"},{"id":490,"name":"Charles Ssebuliba","reg":"VU-MCF-2401-0490-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 3","pct":87,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"c.ssebuliba@vu.ac.ug"},{"id":491,"name":"Winnie Kabuye","reg":"VU-MCF-2401-0491-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 1","pct":97,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"w.kabuye491@vu.ac.ug"},{"id":492,"name":"Timothy Kasule","reg":"VU-MCF-2401-0492-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 2","pct":98,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"t.kasule@vu.ac.ug"},{"id":493,"name":"Victor Nankunda","reg":"VU-MCF-2401-0493-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 3","pct":57,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"v.nankunda493@vu.ac.ug"},{"id":494,"name":"Brian Annet","reg":"VU-MCF-2401-0494-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 2","pct":85,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"b.annet494@vu.ac.ug"},{"id":495,"name":"Annet Lubega","reg":"VU-MCF-2401-0495-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 3","pct":100,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"a.lubega495@vu.ac.ug"},{"id":496,"name":"Benjamin Okello","reg":"VU-MCF-2401-0496-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 1","pct":89,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"b.okello@vu.ac.ug"},{"id":497,"name":"Lillian Sarah","reg":"VU-MCF-2401-0497-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 2","pct":88,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"l.sarah497@vu.ac.ug"},{"id":498,"name":"Collins Namukasa","reg":"VU-MCF-2401-0498-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 3","pct":83,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"c.namukasa@vu.ac.ug"},{"id":499,"name":"Xavier Otim","reg":"VU-MCF-2401-0499-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 2","pct":95,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"x.otim@vu.ac.ug"},{"id":500,"name":"Geoffrey Wasswa","reg":"VU-MCF-2401-0500-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 1","pct":43,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"g.wasswa@vu.ac.ug"},{"id":501,"name":"Aisha Annet","reg":"VU-MCF-2401-0501-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 2","pct":91,"trend":"down","gender":"Male","semester":"Semester 1","mode":"day","email":"a.annet@vu.ac.ug"},{"id":502,"name":"Christine Nakamya","reg":"VU-MCF-2401-0502-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 3","pct":53,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"c.nakamya@vu.ac.ug"},{"id":503,"name":"Bob Nalubega","reg":"VU-MCF-2401-0503-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 1","pct":78,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"b.nalubega@vu.ac.ug"},{"id":504,"name":"Susan Namukasa","reg":"VU-MCF-2401-0504-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 2","pct":79,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"s.namukasa504@vu.ac.ug"},{"id":505,"name":"Sarah Ojok","reg":"VU-MCF-2401-0505-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 3","pct":89,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"s.ojok@vu.ac.ug"},{"id":506,"name":"Geoffrey Annet","reg":"VU-MCF-2401-0506-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 3","pct":94,"trend":"down","gender":"Female","semester":"Semester 2","mode":"day","email":"g.annet@vu.ac.ug"},{"id":507,"name":"Hellen Kibirige","reg":"VU-MCF-2401-0507-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 1","pct":63,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"h.kibirige507@vu.ac.ug"},{"id":508,"name":"Gertrude Tumwesigye","reg":"VU-MCF-2401-0508-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 2","pct":69,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"g.tumwesigye@vu.ac.ug"},{"id":509,"name":"Walter Kibirige","reg":"VU-MCF-2401-0509-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 1","pct":94,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"w.kibirige@vu.ac.ug"},{"id":510,"name":"Nathan Wasswa","reg":"VU-MCF-2401-0510-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 1","pct":84,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"n.wasswa@vu.ac.ug"},{"id":511,"name":"George Bbosa","reg":"VU-MCF-2401-0511-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 3","pct":95,"trend":"up","gender":"Male","semester":"Semester 2","mode":"day","email":"g.bbosa@vu.ac.ug"},{"id":512,"name":"Kevin Kasule","reg":"VU-MCF-2401-0512-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 2","pct":94,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"k.kasule@vu.ac.ug"},{"id":513,"name":"Henry Nakamya","reg":"VU-MCF-2401-0513-EVE","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 2","pct":74,"trend":"down","gender":"Male","semester":"Semester 1","mode":"evening","email":"h.nakamya@vu.ac.ug"},{"id":514,"name":"Hassan Otim","reg":"VU-MCF-2401-0514-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 3","pct":99,"trend":"up","gender":"Female","semester":"Semester 2","mode":"day","email":"h.otim@vu.ac.ug"},{"id":515,"name":"Esther Kyeyune","reg":"VU-MCF-2401-0515-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 1","pct":65,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"e.kyeyune515@vu.ac.ug"},{"id":516,"name":"Brian Nankya","reg":"VU-MCF-2401-0516-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 2","pct":88,"trend":"down","gender":"Female","semester":"Semester 1","mode":"day","email":"b.nankya@vu.ac.ug"},{"id":517,"name":"Dennis Namirembe","reg":"VU-MCF-2401-0517-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 1","pct":79,"trend":"up","gender":"Male","semester":"Semester 1","mode":"day","email":"d.namirembe517@vu.ac.ug"},{"id":518,"name":"Brenda Nankya","reg":"VU-MCF-2401-0518-EVE","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 1","pct":70,"trend":"down","gender":"Female","semester":"Semester 2","mode":"evening","email":"b.nankya518@vu.ac.ug"},{"id":519,"name":"Victor Okello","reg":"VU-MCF-2401-0519-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 3","pct":62,"trend":"down","gender":"Male","semester":"Semester 2","mode":"day","email":"v.okello@vu.ac.ug"},{"id":520,"name":"Linda Kibirige","reg":"VU-MCF-2401-0520-DAY","facultyKey":"arts","faculty":"Faculty of Arts & Education","dept":"Mass Communication","deptKey":"mc","year":"Year 2","pct":76,"trend":"up","gender":"Female","semester":"Semester 1","mode":"day","email":"l.kibirige520@vu.ac.ug"},{"id":521,"name":"Balinda Christopher","reg":"VU-CSF-2601-0521-EVE","facultyKey":"computing","faculty":"Faculty of Computing & Informatics","dept":"Computer Science","deptKey":"cs","year":"Year 3","pct":null,"trend":null,"gender":"Male","semester":"Semester 1","mode":"evening","email":"b.christopher@vu.ac.ug"}];

// Sept 2026 handoff, Part 2: every lecture slot now carries a `mode` field —
// 'day' | 'evening' | null ("no restriction", the default for every
// pre-existing slot below, since none of them were ever mode-restricted
// before this). Students only see slots where mode is null or matches their
// own State.user.mode — see filterLecturesForStudentMode() below.
const SCHEDULE = [
  { day:"Monday", isToday:false, lectures:[
    { code:"CSC3101", name:"Data Structures & Algorithms", dept:"Computer Science", lecturer:"Dr. Patrick Mukasa", room:"LT1 - Main Building", time:"08:00 – 10:00", mode:"day" },
    { code:"CSC3102", name:"Database Systems", dept:"Computer Science", lecturer:"Prof. Sarah Akwango", room:"LT3 - Main Building", time:"10:30 – 12:30", mode:"day" },
    { code:"CSC3101", name:"Data Structures & Algorithms", dept:"Computer Science", lecturer:"Dr. Patrick Mukasa", room:"LT4 - Main Building", time:"17:00 – 19:00", mode:"evening" },
  ]},
  { day:"Tuesday", isToday:false, lectures:[
    { code:"BAR4301", name:"Financial Accounting", dept:"Business Administration", lecturer:"Mr. Alex Otim", room:"LT2 - Business Block", time:"07:00 – 11:00", mode:"day" },
    { code:"BAR4302", name:"Engineering Mathematics", dept:"Civil Engineering", lecturer:"Dr. Grace Atim", room:"LT5 - Engineering Block", time:"14:00 – 16:00", mode:"day" },
    { code:"CSC3102", name:"Database Systems", dept:"Computer Science", lecturer:"Prof. Sarah Akwango", room:"LT4 - Main Building", time:"18:00 – 20:00", mode:"evening" },
  ]},
  { day:"Wednesday", isToday:true, lectures:[
    { code:"CSC3103", name:"Software Engineering", dept:"Computer Science", lecturer:"Dr. Patrick Mukasa", room:"LT1 - Main Building", time:"08:00 – 10:00", status:"pending", mode:"day" },
    { code:"BAR4303", name:"Marketing Management", dept:"Business Administration", lecturer:"Ms. Joy Tumwesigye", room:"LT2 - Business Block", time:"11:00 – 13:00", mode:"day" },
    // Sept 2026 handoff, Part 1: the demo Lecturer account (Dr. Patrick
    // Mukasa) previously had only one lecture on the "today" mock day, so
    // the multi-course session-selection flow had nothing to actually pick
    // between. Added a second one of his own assigned courses (see
    // LECTURER_COURSES) later the same day so the picker/greyed-list flow
    // is real to test, not just theoretical.
    { code:"CSC3101", name:"Data Structures & Algorithms", dept:"Computer Science", lecturer:"Dr. Patrick Mukasa", room:"LT4 - Main Building", time:"14:00 – 16:00", mode:"day" },
    { code:"CSC3103", name:"Software Engineering", dept:"Computer Science", lecturer:"Dr. Patrick Mukasa", room:"LT4 - Main Building", time:"17:00 – 19:00", mode:"evening" },
  ]},
  { day:"Thursday", isToday:false, lectures:[
    { code:"CSC3104", name:"Computer Networks", dept:"Computer Science", lecturer:"Prof. Sarah Akwango", room:"LT3 - Main Building", time:"14:00 – 16:00", mode:"day" },
    { code:"BAR4304", name:"Entrepreneurship", dept:"Business Administration", lecturer:"Mr. Alex Otim", room:"LT2 - Business Block", time:"08:00 – 11:00", mode:"day" },
    { code:"ENG4101", name:"Mechanics", dept:"Civil Engineering", lecturer:"Dr. Grace Atim", room:"LT5 - Engineering Block", time:"13:00 – 15:00", mode:"day" },
    { code:"BAR4301", name:"Financial Accounting", dept:"Business Administration", lecturer:"Mr. Alex Otim", room:"LT2 - Business Block", time:"17:30 – 19:30", mode:"evening" },
  ]},
  { day:"Friday", isToday:false, lectures:[
    { code:"CSC3105", name:"Operating Systems", dept:"Computer Science", lecturer:"Mr. Ivan Tumwesigye", room:"LT1 - Main Building", time:"09:00 – 11:00", mode:"day" },
    { code:"BAR4305", name:"Business Statistics", dept:"Business Administration", lecturer:"Ms. Joy Tumwesigye", room:"LT2 - Business Block", time:"08:00 – 10:00", mode:"day" },
    { code:"CSC3104", name:"Computer Networks", dept:"Computer Science", lecturer:"Prof. Sarah Akwango", room:"LT4 - Main Building", time:"19:00 – 21:00", mode:"evening" },
  ]},
];

const RECORDS = [
  { date:"2026-06-23", reg:"VU-CSF-2401-0001-DAY", name:"Aisha Nakamya", prog:"Computer Science", code:"CSC3101", course:"Data Structures & Algorithms", venue:"LT1 - Main Building", status:"present" },
  { date:"2026-06-23", reg:"VU-CSF-2401-0002-DAY", name:"Brian Ssemwanga", prog:"Computer Science", code:"CSC3101", course:"Data Structures & Algorithms", venue:"LT1 - Main Building", status:"present" },
  { date:"2026-06-23", reg:"VU-CSF-2401-0003-DAY", name:"Christine Namboozo", prog:"Computer Science", code:"CSC3101", course:"Data Structures & Algorithms", venue:"LT1 - Main Building", status:"present" },
  { date:"2026-06-23", reg:"VU-CSF-2401-0004-DAY", name:"David Kiggundu", prog:"Computer Science", code:"CSC3102", course:"Database Systems", venue:"LT3 - Main Building", status:"late" },
  { date:"2026-06-23", reg:"VU-CSF-2401-0006-DAY", name:"Fred Kibirige", prog:"Computer Science", code:"CSC3102", course:"Database Systems", venue:"LT3 - Main Building", status:"absent" },
  { date:"2026-06-22", reg:"VU-CSF-2401-0007-DAY", name:"Grace Nakirya", prog:"Computer Science", code:"CSC3101", course:"Data Structures & Algorithms", venue:"LT1 - Main Building", status:"present" },
  { date:"2026-06-22", reg:"VU-BAF-2401-0015-DAY", name:"Opio Emmanuel", prog:"Business Administration", code:"BAR4301", course:"Financial Accounting", venue:"LT2 - Business Block", status:"absent" },
  { date:"2026-06-22", reg:"VU-BAF-2401-0016-DAY", name:"Prossy Namutebi", prog:"Business Administration", code:"BAR4301", course:"Financial Accounting", venue:"LT2 - Business Block", status:"present" },
  { date:"2026-06-21", reg:"VU-BAF-2401-0013-DAY", name:"Mary Tendo", prog:"Business Administration", code:"BAR4301", course:"Financial Accounting", venue:"LT2 - Business Block", status:"present" },
  { date:"2026-06-21", reg:"VU-BAF-2401-0012-DAY", name:"Lwanga Moses", prog:"Business Administration", code:"BAR4301", course:"Financial Accounting", venue:"LT2 - Business Block", status:"present" },
];

const RECENT_SUBMISSIONS = [
  { name:"Prossy Namutebi", code:"BAR4301", date:"2026-06-23", status:"present" },
  { name:"Opio Emmanuel", code:"BAR4301", date:"2026-06-23", status:"absent" },
  { name:"Nabaale Annet", code:"BAR4301", date:"2026-06-22", status:"late" },
  { name:"Mary Tendo", code:"BAR4301", date:"2026-06-22", status:"present" },
  { name:"Lwanga Moses", code:"BAR4301", date:"2026-06-21", status:"present" },
];

const USERS = {
  // Class Coordinator is NOT a separate login — it's a privilege flag on a student account.
  "VU-CSF-2401-0001-DAY": {
    name:"Aisha Nakamya", role:"student", dept:"Computer Science", year:"Year 2",
    reg:"VU-CSF-2401-0001-DAY", password:"student2026",
    is_class_coordinator: true,
    coordinator_for_programme: "Computer Science",
    coordinator_for_year: "Year 2",
  },
  // Plain student account — no coordinator privileges, for testing the base Student experience.
  "VU-CSF-2401-0002-DAY": {
    name:"Brian Ssemwanga", role:"student", dept:"Computer Science", year:"Year 2",
    reg:"VU-CSF-2401-0002-DAY", password:"student2026",
    is_class_coordinator: false,
  },
  "VU-LEC-101": {
    name:"Dr. Patrick Mukasa", role:"lecturer", dept:"Computer Science", password:"lecturer2026",
    staffId:"VU-LEC-101",
  },
  // Registrars are faculty-scoped — one per faculty, assigned/reassigned by the Administrator.
  // There is no university-wide Registrar; whole-university oversight belongs to the Administrator.
  "VU-REG-COMP-001": {
    name:"Denis Okwir", role:"registrar", dept:null, password:"reg2026",
    staffId:"VU-REG-COMP-001", facultyKey:"computing",
  },
  "VU-REG-BUS-001": {
    name:"Rebecca Auma", role:"registrar", dept:null, password:"reg2026",
    staffId:"VU-REG-BUS-001", facultyKey:"business",
  },
  "VU-REG-ENG-001": {
    name:"Geoffrey Kato", role:"registrar", dept:null, password:"reg2026",
    staffId:"VU-REG-ENG-001", facultyKey:"engineering",
  },
  "VU-REG-SCI-001": {
    name:"Patricia Nansubuga", role:"registrar", dept:null, password:"reg2026",
    staffId:"VU-REG-SCI-001", facultyKey:"science",
  },
  "VU-REG-ART-001": {
    name:"Michael Ouma", role:"registrar", dept:null, password:"reg2026",
    staffId:"VU-REG-ART-001", facultyKey:"arts",
  },
  "VU-ADM-001": {
    name:"Grace Namirembe", role:"administrator", dept:null, password:"admin2026",
    staffId:"VU-ADM-001",
  },
};

// Courses the demo student is enrolled in
const STUDENT_COURSES = [
  { code:"CSC3101", name:"Data Structures & Algorithms", lecturer:"Dr. Patrick Mukasa", color:"#3b82f6" },
  { code:"CSC3102", name:"Database Systems", lecturer:"Prof. Sarah Akwango", color:"#8b5cf6" },
  { code:"CSC3103", name:"Software Engineering", lecturer:"Dr. Patrick Mukasa", color:"#0f766e" },
  { code:"CSC3104", name:"Computer Networks", lecturer:"Prof. Sarah Akwango", color:"#d97706" },
  { code:"CSC3105", name:"Operating Systems", lecturer:"Mr. Ivan Tumwesigye", color:"#dc2626" },
];

const STUDENT_ATTENDANCE_SUMMARY = { rate: 97, present: 28, late: 2, absent: 1, totalSessions: 31 };

// Courses assigned to the demo lecturer (Dr. Patrick Mukasa)
const LECTURER_COURSES = [
  { code:"CSC3101", name:"Data Structures & Algorithms", enrolled:32, attendanceRate:91 },
  { code:"CSC3103", name:"Software Engineering", enrolled:28, attendanceRate:87 },
];

// Class Coordinator scope: students in the coordinator's assigned programme/year
function getCoordinatorClassStudents(){
  const u = State.user;
  if(!u || !u.is_class_coordinator) return [];
  return STUDENTS.filter(s => s.dept === u.coordinator_for_programme && s.year === u.coordinator_for_year);
}

// Lecturer announcements visible to students/coordinators in their courses
const ANNOUNCEMENTS = [
  { id:1, from:"Dr. Patrick Mukasa", course:"CSC3103", title:"Venue change for Friday", body:"Friday's Software Engineering session moves to LT2.", date:"2026-06-24" },
  { id:2, from:"Registrar's Office", course:null, title:"Mid-semester break", body:"Classes suspended June 30 – July 4 for mid-semester break.", date:"2026-06-22" },
];

// Registrar: university-wide oversight data
const PROGRAMME_ANALYTICS = [{"programme": "Computer Science", "facultyKey": "computing", "faculty": "Faculty of Computing & Informatics", "students": 38, "avgAttendance": 84}, {"programme": "Information Technology", "facultyKey": "computing", "faculty": "Faculty of Computing & Informatics", "students": 38, "avgAttendance": 79}, {"programme": "Software Engineering", "facultyKey": "computing", "faculty": "Faculty of Computing & Informatics", "students": 37, "avgAttendance": 81}, {"programme": "Business Administration", "facultyKey": "business", "faculty": "Faculty of Business & Management", "students": 37, "avgAttendance": 80}, {"programme": "Accounting & Finance", "facultyKey": "business", "faculty": "Faculty of Business & Management", "students": 37, "avgAttendance": 83}, {"programme": "Marketing", "facultyKey": "business", "faculty": "Faculty of Business & Management", "students": 37, "avgAttendance": 83}, {"programme": "Civil Engineering", "facultyKey": "engineering", "faculty": "Faculty of Engineering", "students": 37, "avgAttendance": 81}, {"programme": "Electrical Engineering", "facultyKey": "engineering", "faculty": "Faculty of Engineering", "students": 37, "avgAttendance": 84}, {"programme": "Mechanical Engineering", "facultyKey": "engineering", "faculty": "Faculty of Engineering", "students": 37, "avgAttendance": 81}, {"programme": "Biology", "facultyKey": "science", "faculty": "Faculty of Science", "students": 37, "avgAttendance": 85}, {"programme": "Chemistry", "facultyKey": "science", "faculty": "Faculty of Science", "students": 37, "avgAttendance": 84}, {"programme": "Mathematics & Statistics", "facultyKey": "science", "faculty": "Faculty of Science", "students": 37, "avgAttendance": 85}, {"programme": "Education", "facultyKey": "arts", "faculty": "Faculty of Arts & Education", "students": 37, "avgAttendance": 82}, {"programme": "Mass Communication", "facultyKey": "arts", "faculty": "Faculty of Arts & Education", "students": 37, "avgAttendance": 83}];

const FACULTY_ANALYTICS = [{"faculty": "Faculty of Computing & Informatics", "facultyKey": "computing", "students": 113, "programmes": 3, "avgAttendance": 81}, {"faculty": "Faculty of Business & Management", "facultyKey": "business", "students": 111, "programmes": 3, "avgAttendance": 82}, {"faculty": "Faculty of Engineering", "facultyKey": "engineering", "students": 111, "programmes": 3, "avgAttendance": 82}, {"faculty": "Faculty of Science", "facultyKey": "science", "students": 111, "programmes": 3, "avgAttendance": 85}, {"faculty": "Faculty of Arts & Education", "facultyKey": "arts", "students": 74, "programmes": 2, "avgAttendance": 83}];

const LECTURER_COMPLIANCE = [
  { lecturer:"Dr. Patrick Mukasa", sessionsHeld:18, sessionsExpected:20, complianceRate:90 },
  { lecturer:"Prof. Sarah Akwango", sessionsHeld:16, sessionsExpected:16, complianceRate:100 },
  { lecturer:"Mr. Alex Otim", sessionsHeld:11, sessionsExpected:14, complianceRate:79 },
];

// Full staff/people records — used by the Administrator's unified People directory.
// Students are pulled live from STUDENTS; these cover the other three roles.
const LECTURERS = [
  { id:"VU-LEC-101", name:"Dr. Patrick Mukasa", dept:"Computer Science", email:"p.mukasa@vu.ac.ug", status:"active" },
  { id:"VU-LEC-102", name:"Prof. Sarah Akwango", dept:"Computer Science", email:"s.akwango@vu.ac.ug", status:"active" },
  { id:"VU-LEC-103", name:"Mr. Ivan Tumwesigye", dept:"Computer Science", email:"i.tumwesigye@vu.ac.ug", status:"active" },
  { id:"VU-LEC-104", name:"Mr. Alex Otim", dept:"Business Administration", email:"a.otim@vu.ac.ug", status:"active" },
];

const REGISTRARS = [
  { id:"VU-REG-COMP-001", name:"Denis Okwir", dept:"Faculty of Computing & Informatics", facultyKey:"computing", email:"d.okwir@vu.ac.ug", status:"active" },
  { id:"VU-REG-BUS-001", name:"Rebecca Auma", dept:"Faculty of Business & Management", facultyKey:"business", email:"r.auma@vu.ac.ug", status:"active" },
  { id:"VU-REG-ENG-001", name:"Geoffrey Kato", dept:"Faculty of Engineering", facultyKey:"engineering", email:"g.kato@vu.ac.ug", status:"active" },
  { id:"VU-REG-SCI-001", name:"Patricia Nansubuga", dept:"Faculty of Science", facultyKey:"science", email:"p.nansubuga@vu.ac.ug", status:"active" },
  { id:"VU-REG-ART-001", name:"Michael Ouma", dept:"Faculty of Arts & Education", facultyKey:"arts", email:"m.ouma@vu.ac.ug", status:"active" },
];

const ADMINISTRATORS = [
  { id:"VU-ADM-001", name:"Grace Namirembe", dept:null, email:"g.namirembe@vu.ac.ug", status:"active" },
];

// Flattened directory: every person in the system, tagged with role, for Administrator use only.
function getStaffDirectory(){
  // Status and provisioning state are read live from USERS (the mock/demo
  // login records) AND from LIVE_PROVISIONED_IDS (real Supabase accounts,
  // via isProvisionedAccount() — see loadProvisionedAccountsFromSupabase())
  // — a directory listing should never claim someone has no account just
  // because they weren't one of the hardcoded demo logins, and a
  // suspension needs to be reflected here the moment it happens.
  const students = STUDENTS.map(s => {
    const account = USERS[s.reg];
    const provisioned = isProvisionedAccount(s.reg);
    return {
      // Sept 2026 handoff, Part 1: STUDENTS records now carry a real `email`
      // field (and `mode`) rather than only ever deriving it on the fly —
      // fall back to vuEmail() for any legacy record that somehow lacks one.
      id:s.reg, name:s.name, role:"student", dept:s.dept, email: s.email || vuEmail(s.name),
      status: account ? (account.status || 'active') : (provisioned ? 'active' : 'unprovisioned'),
      hasAccount: provisioned,
    };
  });
  const lecturers = LECTURERS.map(l => {
    const account = USERS[l.id];
    const provisioned = isProvisionedAccount(l.id);
    return { ...l, role:"lecturer", status: account ? (account.status || 'active') : (provisioned ? 'active' : (l.status || 'active')), hasAccount: provisioned };
  });
  const registrars = REGISTRARS.map(r => {
    const account = USERS[r.id];
    const provisioned = isProvisionedAccount(r.id);
    return { ...r, role:"registrar", status: account ? (account.status || 'active') : (provisioned ? 'active' : (r.status || 'active')), hasAccount: provisioned };
  });
  const administrators = ADMINISTRATORS.map(a => {
    const account = USERS[a.id];
    const provisioned = isProvisionedAccount(a.id);
    return { ...a, role:"administrator", status: account ? (account.status || 'active') : (provisioned ? 'active' : (a.status || 'active')), hasAccount: provisioned };
  });
  return [...administrators, ...registrars, ...lecturers, ...students];
}

const ATTENDANCE_APPEALS = [
  { id:1, student:"David Kiggundu", course:"CSC3102", session:"2026-06-23", reason:"Marked absent but attended in person — lecturer can confirm.", status:"pending" },
  { id:2, student:"Fred Kibirige", course:"CSC3102", session:"2026-06-23", reason:"Phone battery died, could not scan QR or get PIN in time.", status:"pending" },
  { id:3, student:"Opio Emmanuel", course:"BAR4301", session:"2026-06-22", reason:"Was in the room but check-in window had already closed.", status:"resolved" },
];

// Live session — what the lecturer is currently broadcasting for students to check into.
// In a real backend this token rotates server-side; here we simulate rotation client-side.
// ============================================================
// ATTENDANCE POLICIES (Administrator-configurable)
// ------------------------------------------------------------
// Centralizes the thresholds that used to be hardcoded in several places
// (the 75% present/at-risk cutoff, the QR rotation interval, the session
// window). Changing a value here takes effect immediately for anything
// that reads it live; LIVE_SESSION's own fields are snapshotted from this
// at the moment a NEW session starts, so editing policy mid-session doesn't
// retroactively change a session that's already running.
// ============================================================
const ATTENDANCE_POLICIES = {
  minAttendancePct: 75,        // present/at-risk cutoff used across student views, class summary, exam eligibility
  qrRotateSeconds: 30,         // how often the Lecturer's QR token regenerates
  sessionWindowMinutes: 10,    // how long a check-in session stays open
  lateGraceMinutes: 10,        // minutes after session start still counted as "late" rather than "absent" (reference value; not yet enforced by a timer)
  graceApplied: false,         // record-keeping flag for future use, mirrors the schema's attendance_policies table
};

let LIVE_SESSION = {
  active: true,
  liveSessionId: null, // Supabase row id for this session, once written live (Gate 3 Realtime sync)
  schedulingSessionId: null, // Gate 4: `sessions` (scheduling) row id for today's lecture — distinct from liveSessionId above, see liveEnsureSchedulingSession()
  courseCode:"CSC3103",
  courseName:"Software Engineering",
  room:"LT1 - Main Building",
  startedAt: Date.now(),
  windowSeconds: 600, // session stays open 10 min — refreshed from policy on each new startSessionForLecture()
  pin: "482917".slice(0,6),
  tokenRotateSeconds: 30, // refreshed from policy on each new startSessionForLecture()
  token: "QR-" + Math.random().toString(36).slice(2,10).toUpperCase(),
};

function regenerateSessionToken(){
  LIVE_SESSION.token = "QR-" + Math.random().toString(36).slice(2,10).toUpperCase();
}

// Sept 2026 handoff — shared "is a session genuinely running" check (gotcha:
// LIVE_SESSION.active alone isn't reliable, since it defaults to true above
// before any session has ever actually started — a mock-mode-only display
// convenience). The reliable signal combines it with liveSessionId, which is
// only ever set once a broadcast is actually confirmed — see
// startSessionForLecture() for how liveSessionId gets a real (if synthetic,
// in mock mode) value the moment a session genuinely starts. Both Part 1's
// greyed-out Today's Lectures list and Part 2's Student Home banner key off
// this one function so they can't drift on what "active" means.
function isLiveSessionActive(){
  return !!(LIVE_SESSION.liveSessionId && LIVE_SESSION.active);
}

function isLiveSessionOpenForStudent(){
  // Same reasoning as the Live-badge fix above: a course can now have both
  // a Day and Evening section, so course code alone isn't enough to know
  // this broadcast is actually relevant to THIS student. The downstream
  // mismatch check in resolveCheckInOutcome() would still correctly block
  // a genuine mode mismatch if they tried to check in anyway — but without
  // this, the banner itself would misleadingly invite them to in the first
  // place. Backward-compatible: if either side's mode isn't set (older
  // data, or a session started before mode tracking existed), don't block
  // on it — only compare when there's actually something to compare.
  const modeOk = !LIVE_SESSION.mode || !State.user?.mode || LIVE_SESSION.mode === State.user.mode;
  return isLiveSessionActive() && STUDENT_COURSES.some(c => c.code === LIVE_SESSION.courseCode) && modeOk;
}

// ============================================================
// LIVE SESSION DEBUG PANEL (temporary — remove once Gate 3 Realtime
// sync is confirmed working end-to-end). Shows a small on-screen readout
// of the Realtime subscription state on Lecturer's Start Session screen
// and Student's Check-In screen, so this can be verified on a phone
// without needing a plugged-in console.
// ============================================================
let DEBUG_LIVE_SESSION_PANEL = false;

function ensureLiveDebugPanel(){
  let panel = document.getElementById('liveDebugPanel');
  if(!panel){
    panel = document.createElement('div');
    panel.id = 'liveDebugPanel';
    panel.style.cssText = `
      position:fixed; bottom:76px; left:8px; right:8px; z-index:99999;
      background:rgba(17,24,39,0.94); color:#e5e7eb; font-family:monospace;
      font-size:11px; line-height:1.6; padding:8px 10px; border-radius:10px;
      border:1px solid rgba(255,255,255,0.15); pointer-events:none;
      white-space:pre-wrap;
    `;
    document.body.appendChild(panel);
  }
  return panel;
}

function removeLiveDebugPanel(){
  const panel = document.getElementById('liveDebugPanel');
  if(panel) panel.remove();
}

function updateDebugPanel(){
  if(!DEBUG_LIVE_SESSION_PANEL) return;
  const panel = ensureLiveDebugPanel();
  const subStatus = typeof liveSessionUpdatesUnsubscribe === 'function' ? 'subscribed ✅' : 'not subscribed ❌';
  panel.textContent =
`LIVE SESSION DEBUG
backend: ${LIVE_BACKEND ? 'live' : 'offline/mock'}
sync: ${subStatus}
broadcast id: ${LIVE_SESSION.liveSessionId || '—'}
scheduling session id: ${LIVE_SESSION.schedulingSessionId || '—'}
course: ${LIVE_SESSION.courseCode}
token: ${LIVE_SESSION.token}
active: ${LIVE_SESSION.active}
updated: ${new Date().toLocaleTimeString()}`;
}

const SUSPICION_LOG = [
  { id:1, student:"David Kiggundu", reason:"Same device used for 2 students within 4 minutes", severity:"high", course:"CSC3102", date:"2026-06-23 08:14", deviceId:"DVC-7F3A91" },
  { id:2, student:"Fred Kibirige", reason:"Check-in attempted after session window closed", severity:"medium", course:"CSC3102", date:"2026-06-23 08:42", deviceId:"DVC-2C88B0" },
  { id:3, student:"Opio Emmanuel", reason:"PIN entered matched but device fingerprint mismatch from enrollment", severity:"high", course:"BAR4301", date:"2026-06-22 07:21", deviceId:"DVC-91AAC4" },
];
let suspicionNextId = SUSPICION_LOG.length + 1;

// ============================================================
// FRAUD THRESHOLDS
// ============================================================
const FRAUD_THRESHOLDS = {
  sharedDeviceWindowMinutes: 4,    // flag if same device checks in 2+ students within N minutes
  lateWindowAfterClose: 0,         // minutes after session close still accepted (0 = strict)
  maxCheckInsPerDevice: 1,         // max unique students per device per session
  deviceFingerprintCheck: true,    // flag mismatch between enrollment and check-in device
  flagOnVPN: false,                // flag check-ins originating from known VPN ranges
  autoEscalateHighSeverity: true,  // auto-notify Registrar when a high-severity flag is raised
};

// ============================================================
// NOTIFICATION TEMPLATES
// ============================================================
const NOTIFICATION_TEMPLATES = {
  lowAttendanceWarning: {
    label: 'Low Attendance Warning',
    description: 'Sent to students who fall below the minimum attendance threshold',
    subject: 'Low Attendance Warning — {courseName}',
    body: 'Dear {studentName},\n\nYour attendance in {courseName} has dropped to {attendancePct}%, which is below the required {minPct}%. Please take immediate steps to improve your attendance.\n\nIf you believe this is in error, submit an appeal through the VUSAP portal.\n\nVictoria University Attendance Office',
    enabled: true,
  },
  sessionStarted: {
    label: 'Session Started',
    description: 'Sent to enrolled students when a lecturer opens a check-in session',
    subject: 'Check-in now open — {courseName}',
    body: 'Dear {studentName},\n\n{lecturerName} has opened a check-in session for {courseName}. You have {windowMinutes} minutes to mark your attendance.\n\nOpen VUSAP to check in now.',
    enabled: true,
  },
  appealResolved: {
    label: 'Appeal Resolved',
    description: 'Sent to students when their attendance appeal is approved or rejected',
    subject: 'Your attendance appeal has been {resolution}',
    body: 'Dear {studentName},\n\nYour appeal for {courseName} on {sessionDate} has been {resolution}.\n\n{resolutionNote}\n\nFor questions, contact your Registrar.\n\nVictoria University',
    enabled: true,
  },
  accountProvisioned: {
    label: 'Account Provisioned',
    description: 'Sent to new users with their login credentials',
    subject: 'Your VUSAP account is ready',
    body: 'Dear {name},\n\nYour Victoria University Smart Attendance Portal account has been created.\n\nLogin ID: {userId}\nTemporary Password: {tempPassword}\n\nPlease log in and change your password immediately.\n\nVictoria University',
    enabled: true,
  },
  fraudFlagged: {
    label: 'Fraud Flag Alert',
    description: 'Sent to Registrars when a high-severity fraud flag is raised',
    subject: 'Fraud alert — {studentName} in {courseName}',
    body: 'A high-severity attendance fraud flag has been raised.\n\nStudent: {studentName}\nCourse: {courseName}\nReason: {reason}\nDate: {date}\n\nPlease review in the VUSAP Fraud Center.',
    enabled: true,
  },
};

// ============================================================
// SYSTEM SETTINGS
// ============================================================
const SYSTEM_SETTINGS = {
  maintenanceMode: false,       // when true, blocks all non-Principal logins at the auth layer
  autoLogoutMinutes: 30,        // inactivity timeout before a session is terminated
  allowSelfEnrollment: false,   // whether students can self-enroll without a Registrar
  requireEmailVerification: true,
  systemName: 'VUSAP',
  institutionName: 'Victoria University',
  supportEmail: 'support@vu.ac.ug',
  academicYear: '2025/2026',
};

// ============================================================
// AUDIT LOG
// ============================================================
const AUDIT_LOG = [
  { id:1, actor:'VU-ADM-001', actorName:'Grace Namirembe', action:'Account suspended', target:'VU-LEC-102', detail:'Prof. Sarah Akwango account suspended', timestamp:'2026-06-20 09:14' },
  { id:2, actor:'VU-ADM-001', actorName:'Grace Namirembe', action:'Faculty created', target:'computing', detail:'Faculty of Computing & Informatics', timestamp:'2026-06-18 14:02' },
  { id:3, actor:'VU-REG-COMP-001', actorName:'Denis Okwir', action:'Appeal resolved', target:'appeal-1', detail:'David Kiggundu appeal approved', timestamp:'2026-06-24 10:30' },
  { id:4, actor:'VU-ADM-001', actorName:'Grace Namirembe', action:'Policy updated', target:'policies', detail:'minAttendancePct changed from 70 to 75', timestamp:'2026-06-15 11:00' },
  { id:5, actor:'VU-LEC-101', actorName:'Dr. Patrick Mukasa', action:'Session started', target:'CSC3103', detail:'Software Engineering session opened', timestamp:'2026-06-24 08:00' },
];

let auditLogNextId = AUDIT_LOG.length + 1;

function logAuditEvent(actor, actorName, action, target, detail){
  AUDIT_LOG.unshift({
    id: auditLogNextId++,
    actor, actorName, action, target, detail,
    timestamp: new Date().toISOString().replace('T',' ').slice(0,16),
  });
  // Keep the log manageable in the prototype
  if(AUDIT_LOG.length > 200) AUDIT_LOG.pop();
  liveWriteAuditEvent(actor, actorName, action, target, detail); // fire-and-forget — local log above already succeeded either way
}

// ------------------------------------------------------------
// AUDIT LOG — live read/write (Gate 4, part 5). All 15 call sites of
// logAuditEvent() funnel through this one function, so this single write
// covers every one of them. Read is fetched on visiting the Audit System
// screen (not at login — admin-only, occasional-use, and the log can grow
// large), same additive/fallback pattern as everything else in Gate 4.
// ------------------------------------------------------------

async function liveWriteAuditEvent(actor, actorName, action, target, detail){
  if(!LIVE_BACKEND) return;
  try {
    const { error } = await SUPABASE_CLIENT
      .from('audit_log')
      .insert({ actor, actor_name: actorName, action, target, detail });
    if(error) console.warn('liveWriteAuditEvent failed:', error);
  } catch(e){
    console.warn('liveWriteAuditEvent error:', e);
  }
}

async function loadAuditLogFromSupabase(){
  if(!LIVE_BACKEND) return;
  try {
    const { data: rows, error } = await SUPABASE_CLIENT
      .from('audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if(error){ console.warn('Audit log fetch failed, keeping mock AUDIT_LOG:', error); return; }
    if(!rows || rows.length === 0) return; // no live rows yet — keep mock so the trail isn't empty

    const fetched = rows.map(r => ({
      id: r.id,
      actor: r.actor,
      actorName: r.actor_name,
      action: r.action,
      target: r.target,
      detail: r.detail,
      // Match the existing mock format exactly ("YYYY-MM-DD HH:MM") so
      // auditEventRow() needs no changes at all.
      timestamp: r.created_at ? r.created_at.replace('T',' ').slice(0,16) : '',
    }));

    AUDIT_LOG.length = 0;
    AUDIT_LOG.push(...fetched);
    refreshScreenContentOnly(); // hook-free — see its own comment for why not rerenderCurrentScreen()
  } catch(e){
    console.warn('loadAuditLogFromSupabase error, keeping mock AUDIT_LOG:', e);
  }
}

// ============================================================
// NOTIFICATIONS (in-memory inbox — ports 1:1 to Supabase later)
// ============================================================
const NOTIFICATIONS = [
  { id:1, recipientRole:'student', recipientId:'VU-CSF-2401-0002-DAY', type:'lowAttendanceWarning', title:'Low Attendance Warning', body:'Your attendance in CSC3102 has dropped to 72%. Please attend more sessions.', date:'2026-06-24', read:false },
  { id:2, recipientRole:'all', recipientId:null, type:'sessionStarted', title:'Check-in open — CSC3103', body:'Dr. Patrick Mukasa has opened a check-in session for Software Engineering. You have 10 minutes.', date:'2026-06-24', read:false },
  { id:3, recipientRole:'registrar', recipientId:'VU-REG-COMP-001', type:'fraudFlagged', title:'Fraud alert — David Kiggundu', body:'A high-severity fraud flag has been raised for CSC3102 on 23-Jun-2026.', date:'2026-06-23', read:true },
  { id:4, recipientRole:'student', recipientId:'VU-CSF-2401-0001-DAY', type:'appealResolved', title:'Appeal approved — CSC3101', body:'Your attendance appeal for the session on 22-Jun-2026 has been approved.', date:'2026-06-22', read:true },
  { id:5, recipientRole:'lecturer', recipientId:'VU-LEC-101', type:'sessionStarted', title:'Session reminder', body:'You have a Software Engineering session today at 08:00 in LT1 - Main Building.', date:'2026-06-24', read:false },
];
let notifNextId = NOTIFICATIONS.length + 1;

function pushNotification({ recipientRole, recipientId, type, title, body, courseCode, from, fromId }){
  const createdAt = new Date().toISOString();
  NOTIFICATIONS.unshift({
    id: notifNextId++,
    recipientRole, recipientId, type, title, body,
    courseCode: courseCode || null,
    from: from || null,
    date: createdAt.slice(0,10),
    createdAt,
    read: false,
  });
  // Track a copy in the sender's own "Sent" history, immediately and
  // locally (independent of whether the live write below succeeds), so the
  // sender always sees confirmation of what they sent, same session or not.
  if(from && fromId){
    SENT_NOTIFICATIONS.unshift({
      id: sentNotifNextId++,
      fromId, from,
      recipientRole, recipientId, courseCode: courseCode || null,
      title, body,
      date: createdAt.slice(0,10),
      createdAt,
    });
  }
  liveWriteNotification({ recipientRole, recipientId, type, title, body, courseCode, from, fromId }); // fire-and-forget — local push above already succeeded either way
}

// Formats an ISO timestamp the way a receiver should see it: relative
// "Today, 3:45 PM" for anything from today, otherwise a short date + time.
// Falls back to just the plain date string for older rows that predate
// this field (mock seed data, or anything inserted before created_at was
// wired through) — those still show something reasonable, just no time.
function formatNotifTimestamp(n){
  if(!n.createdAt) return n.date || '';
  const d = new Date(n.createdAt);
  if(isNaN(d.getTime())) return n.date || '';
  const now = new Date();
  const timeStr = d.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
  if(d.toDateString() === now.toDateString()) return `Today, ${timeStr}`;
  const dateStr = d.toLocaleDateString([], { month:'short', day:'numeric' });
  return `${dateStr}, ${timeStr}`;
}

// ------------------------------------------------------------
// NOTIFICATIONS — live read/write (Gate 4, part 4). Same additive/
// fallback pattern as Enrollments/Faculties: on any failure this silently
// keeps whatever the in-memory NOTIFICATIONS array already had, and every
// screen reads NOTIFICATIONS (via notificationsForCurrentUser()) fresh on
// each render so a later-resolving fetch just takes effect automatically.
// ------------------------------------------------------------

async function liveWriteNotification({ recipientRole, recipientId, type, title, body, courseCode, from, fromId }){
  if(!LIVE_BACKEND) return;
  try {
    const { error } = await SUPABASE_CLIENT
      .from('notifications')
      .insert({
        recipient_role: recipientRole,
        recipient_id: recipientId,
        type, title, body,
        course_code: courseCode || null,
        from_name: from || null,
        from_id: fromId || null,
        date: new Date().toISOString().slice(0,10),
        read: false,
      });
    if(error) console.warn('liveWriteNotification failed:', error);
  } catch(e){
    console.warn('liveWriteNotification error:', e);
  }
}

// Sent history — separate from the recipient-scoped NOTIFICATIONS array,
// since a sender's own inbox (filtered by their own role) never contains
// copies of what they sent to a different role. Same additive/fallback
// pattern: local SENT_NOTIFICATIONS from this session always shows
// immediately; a live fetch (keyed by from_id) fills in anything sent from
// other sessions/devices, deduped by id.
let SENT_NOTIFICATIONS = [];
let sentNotifNextId = 1;

async function loadSentNotificationsFromSupabase(){
  if(!LIVE_BACKEND || !State.user) return;
  const userId = State.user.id || State.user.reg || State.user.staffId;
  if(!userId) return;
  try {
    const { data: rows, error } = await SUPABASE_CLIENT
      .from('notifications')
      .select('*')
      .eq('from_id', userId)
      .order('created_at', { ascending: false });

    if(error){ console.warn('Sent notifications fetch failed:', error); return; }
    if(!rows) return;

    const fetched = rows.map(r => ({
      id: r.id,
      fromId: r.from_id, from: r.from_name,
      recipientRole: r.recipient_role, recipientId: r.recipient_id, courseCode: r.course_code,
      title: r.title, body: r.body, date: r.date,
      createdAt: r.created_at,
    }));

    // Merge rather than replace: keep any locally-pushed items from this
    // session that the live fetch hasn't caught up to yet (Supabase
    // read-after-write can lag by a beat), matching on title+date+recipient
    // since local items use numeric ids while live rows use uuids.
    const isDuplicate = (local, live) => local.title === live.title && local.date === live.date &&
      local.recipientRole === live.recipientRole && local.recipientId === live.recipientId && local.courseCode === live.courseCode;
    const localOnly = SENT_NOTIFICATIONS.filter(local => !fetched.some(live => isDuplicate(local, live)));

    SENT_NOTIFICATIONS = [...localOnly, ...fetched].sort((a,b) => (a.date < b.date ? 1 : -1));
    refreshScreenContentOnly(); // hook-free refresh — see comment on refreshScreenContentOnly() for why not rerenderCurrentScreen()
  } catch(e){
    console.warn('loadSentNotificationsFromSupabase error:', e);
  }
}

// Turns a notification's targeting fields back into readable text for the
// Sent history list — mirrors the option labels on the compose screen.
function describeNotificationRecipient(n){
  if(n.courseCode) return `Students in ${n.courseCode}`;
  if(n.recipientId){
    const sources = [STUDENTS, LECTURERS, REGISTRARS, ADMINISTRATORS];
    for(const list of sources){
      const match = list.find(p => (p.reg || p.id) === n.recipientId);
      if(match) return match.name;
    }
    return n.recipientId;
  }
  const roleLabel = { student:'Students', lecturer:'Lecturers', registrar:'Registrars', all:'Everyone' };
  return `All ${roleLabel[n.recipientRole] || n.recipientRole}`;
}

async function loadNotificationsFromSupabase(){
  if(!LIVE_BACKEND || !State.role) return;
  try {
    const { data: rows, error } = await SUPABASE_CLIENT
      .from('notifications')
      .select('*')
      .in('recipient_role', [State.role, 'all'])
      .order('date', { ascending: false });

    if(error){
      console.warn('Notifications fetch failed, keeping mock NOTIFICATIONS:', error);
      return;
    }
    if(!rows || rows.length === 0) return; // no live rows yet — keep mock so the inbox isn't empty

    const newNotifications = rows.map(r => ({
      id: r.id,
      recipientRole: r.recipient_role,
      recipientId: r.recipient_id,
      type: r.type,
      title: r.title,
      body: r.body,
      courseCode: r.course_code || null,
      from: r.from_name || null,
      date: r.date,
      createdAt: r.created_at,
      read: r.read,
    }));

    NOTIFICATIONS.length = 0;
    NOTIFICATIONS.push(...newNotifications);
    // notifNextId only matters for new local-only pushes before the next
    // live insert lands; keep it clear of any live numeric-looking ids.
    notifNextId = Math.max(notifNextId, NOTIFICATIONS.length + 1);
    refreshScreenContentOnly(); // hook-free refresh — see comment on refreshScreenContentOnly() for why not rerenderCurrentScreen()
  } catch(e){
    console.warn('loadNotificationsFromSupabase error, keeping mock NOTIFICATIONS:', e);
  }
}

// Course-scoped notifications (from "Students in a Course") are a single
// shared row rather than one per enrolled student, so a course match is
// required in addition to the role/recipientId check. Only students can
// match a courseCode; STUDENT_COURSES holds the current student's live (or
// mock-fallback) enrollment, same source the rest of the app already reads.
function notificationsForCurrentUser(){
  if(!State.role || !State.user) return [];
  const userId = State.user.id || State.user.reg || State.user.staffId;
  // Some writers (e.g. the reschedule announcement in submitNewSession)
  // address recipientId by the raw Supabase users.id UUID — the same id
  // enrollments.student_id/attendance.student_id FK against — rather than
  // the university-ID-shaped `id` above. Match either shape so those
  // notifications actually reach the recipient instead of being silently
  // filtered out.
  const supabaseId = State.user.supabaseId || null;
  return NOTIFICATIONS.filter(n => {
    if(n.recipientRole === 'all') return true;
    if(n.recipientRole !== State.role) return false;
    if(n.recipientId && n.recipientId !== userId && n.recipientId !== supabaseId) return false;
    if(n.courseCode){
      if(State.role !== 'student') return false;
      return STUDENT_COURSES.some(c => c.code === n.courseCode);
    }
    return true;
  });
}


function unreadNotifCount(){
  return notificationsForCurrentUser().filter(n => !n.read).length;
}

function markAllNotifsRead(){
  notificationsForCurrentUser().forEach(n => { n.read = true; });
  liveMarkNotificationsRead(); // fire-and-forget — local mark-as-read above already succeeded either way
}

async function liveMarkNotificationsRead(){
  if(!LIVE_BACKEND || !State.role) return;
  try {
    const userId = State.user ? (State.user.id || State.user.reg || State.user.staffId) : null;
    const supabaseId = State.user ? (State.user.supabaseId || null) : null;
    // Mirrors notificationsForCurrentUser()'s filter: this role or 'all',
    // and either no specific recipient or it's this user — matched against
    // either id shape a writer may have used (see that function's comment).
    let query = SUPABASE_CLIENT
      .from('notifications')
      .update({ read: true })
      .in('recipient_role', [State.role, 'all']);
    const idFilters = ['recipient_id.is.null'];
    if(userId) idFilters.push(`recipient_id.eq.${userId}`);
    if(supabaseId) idFilters.push(`recipient_id.eq.${supabaseId}`);
    query = query.or(idFilters.join(','));
    const { error } = await query;
    if(error) console.warn('liveMarkNotificationsRead failed:', error);
  } catch(e){
    console.warn('liveMarkNotificationsRead error:', e);
  }
}

// ---------- STATE ----------
const State = {
  role: null,
  user: null,
  attendanceDraft: {}, // studentId -> 'p'|'l'|'a'
  hasCheckedInToday: false,
  checkInVerifying: false, // Sept 2026 handoff, Part 2 — true only while resolveCheckInOutcome() is in flight
  pinEntry: "",
  pendingUserId: null, // userId mid-flow during forced password change or password reset
};

function initials(name){
  return name.split(" ").map(p=>p[0]).slice(0,2).join("").toUpperCase();
}

// Cycles a fixed 8-color palette based on a key's position in a reference list,
// so any number of programmes/faculties gets a consistent, distinct color
// without needing one hardcoded CSS class per key.
function palClass(key, refList){
  if(!key || !refList || !refList.length) return 'pal-0';
  const idx = refList.findIndex(k => k === key);
  return `pal-${(idx < 0 ? 0 : idx) % 8}`;
}

const HONORIFICS = new Set(["dr.","dr","prof.","prof","mr.","mr","mrs.","mrs","ms.","ms"]);
function firstName(name){
  if(!name) return 'there';
  const parts = name.split(" ");
  const idx = HONORIFICS.has(parts[0].toLowerCase()) ? 1 : 0;
  return parts[idx] || parts[0];
}

function vuEmail(name){
  const parts = name.split(" ").filter(p=>!HONORIFICS.has(p.toLowerCase().replace(/\.$/,'.')) && !HONORIFICS.has(p.toLowerCase()));
  if(parts.length < 2) return (parts[0] || "user").toLowerCase() + "@vu.ac.ug";
  const last = parts[parts.length-1];
  const firstInitial = parts[0][0];
  return `${firstInitial}.${last}`.toLowerCase() + "@vu.ac.ug";
}

function facultyName(facultyKey){
  const fac = FACULTIES.find(f => f.key === facultyKey);
  return fac ? fac.name : 'Unassigned Faculty';
}

// ============================================================
// SHARED: SCHEDULE TIME PARSING (Sept 2026 handoff — multi-course session
// selection + compliance, Part 1; student countdown/late warning, Part 2)
// ------------------------------------------------------------
// SCHEDULE's `time` field is a string shaped "HH:MM – HH:MM" — note that's
// an EN DASH (–, U+2013), not a hyphen, surrounded by spaces (see SCHEDULE's
// own shape comment). One parser here, used by both Part 1's CL/DL/LOT
// classification and Part 2's countdown/late-warning, so the two can never
// drift on the format.
// ============================================================

// Parses "HH:MM – HH:MM" against a reference day (defaults to right now,
// i.e. "today") and returns real Date objects for the scheduled start/end.
// Returns null on anything malformed rather than throwing — a bad/edited
// SCHEDULE entry should never crash a render.
function parseLectureTimeRange(timeStr, referenceDate){
  const base = referenceDate ? new Date(referenceDate) : new Date();
  const parts = String(timeStr || '').split('–').map(s => s.trim());
  if(parts.length !== 2) return null;
  const toDateOnDay = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
    if(!m) return null;
    const d = new Date(base);
    d.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
    return d;
  };
  const start = toDateOnDay(parts[0]);
  const end = toDateOnDay(parts[1]);
  if(!start || !end) return null;
  return { start, end };
}

// Pure classification, given real Date objects — kept separate from the
// string parsing above so the thresholds themselves are easy to read/test
// in isolation. Thresholds are exact per the brief, not up for reinterpretation:
//   CL  — started within ±5 minutes of the scheduled start.
//   DL  — started more than 5 minutes after the scheduled start, but still
//         before the scheduled end.
//   LOT — started more than 5 minutes before the scheduled start, OR any
//         time after the scheduled end (checked first: "after end" always
//         wins regardless of how the start-time comparison would read).
function classifyLectureCompliance(scheduledStart, scheduledEnd, actualStart){
  const FIVE_MIN_MS = 5 * 60 * 1000;
  if(actualStart.getTime() > scheduledEnd.getTime()) return 'LOT';
  const diffMs = actualStart.getTime() - scheduledStart.getTime(); // +ve = late, -ve = early
  if(diffMs < -FIVE_MIN_MS) return 'LOT';
  if(diffMs <= FIVE_MIN_MS) return 'CL';
  return 'DL';
}

function formatClockTime(date){
  return `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
}

// ============================================================
// ACCOUNT PROVISIONING & PASSWORD RESET
// ------------------------------------------------------------
// This whole block is written as a thin mock layer standing in for what will
// become real Supabase Auth calls later (createUser, updateUser password,
// auth.resetPasswordForEmail, etc). The function boundaries below are meant
// to map 1:1 onto those calls, so swapping the mock body for a real fetch/SDK
// call later shouldn't require touching any of the screens that call them.
// ============================================================

// A temporary password readable enough to communicate verbally/in writing,
// but not a real word — 2 letters, 4 digits, 2 letters, e.g. "Kp4821Qm".
function generateTempPassword(){
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";
  const pick = (pool, n) => Array.from({length:n}, () => pool[Math.floor(Math.random()*pool.length)]).join('');
  return pick(letters, 2) + pick("0123456789", 4) + pick(letters, 2);
}

// Creates a USERS entry for a newly-enrolled person with a one-time temporary
// password. Returns the temp password so the caller (Admin/Registrar screen)
// can show it ONCE in a dismissible confirmation — it is never stored or
// displayed anywhere else afterward, which is the actual point of this design:
// nobody should ever see a list of real passwords.
function createAccount({ id, name, email, role, extra }){
  const tempPassword = generateTempPassword();
  USERS[id] = {
    name, role, email,
    password: tempPassword,
    mustChangePassword: true,
    ...extra,
  };
  return tempPassword;
}

function changePassword(userId, newPassword){
  const user = USERS[userId];
  if(!user) return false;
  user.password = newPassword;
  user.mustChangePassword = false;
  return true;
}

// Generates the next sequential staff ID for a role, e.g. VU-LEC-105 given
// VU-LEC-101..104 already exist. Scans USERS (the real source of truth)
// rather than the directory arrays so a freshly-created ID never collides
// even if the two have drifted.
function nextStaffId(prefix, directoryArray){
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  Object.keys(USERS).forEach(id => {
    const m = id.match(re);
    if(m) max = Math.max(max, parseInt(m[1], 10));
  });
  (directoryArray || []).forEach(entry => {
    const m = (entry.id || '').match(re);
    if(m) max = Math.max(max, parseInt(m[1], 10));
  });
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

// Creates a Lecturer, Registrar, or Administrator account from the User
// Management "Create Account" form. Students are NOT handled here — they
// already have a dedicated flow (Student Register -> Enroll Student) that
// also creates the academic STUDENTS record a login alone can't capture.
function createStaffAccount(role, name, email, deptOrFaculty){
  if(!name || !name.trim()) return { error: 'Enter a full name' };
  let id, extra = {}, directoryArray, directoryEntry;

  if(role === 'lecturer'){
    id = nextStaffId('VU-LEC', LECTURERS);
    extra = { dept: deptOrFaculty || null };
    directoryArray = LECTURERS;
    directoryEntry = { id, name: name.trim(), dept: deptOrFaculty || null, email: email || vuEmail(name), status: 'active' };
  } else if(role === 'registrar'){
    id = nextStaffId('VU-REG-NEW', REGISTRARS);
    extra = { facultyKey: null }; // unassigned until seated via Role Assignments
    directoryArray = REGISTRARS;
    directoryEntry = { id, name: name.trim(), dept: null, facultyKey: null, email: email || vuEmail(name), status: 'active' };
  } else if(role === 'administrator'){
    id = nextStaffId('VU-ADM', ADMINISTRATORS);
    directoryArray = ADMINISTRATORS;
    directoryEntry = { id, name: name.trim(), dept: null, email: email || vuEmail(name), status: 'active' };
  } else {
    return { error: 'Unsupported role' };
  }

  const tempPassword = createAccount({ id, name: name.trim(), email: email || vuEmail(name), role, extra });
  directoryArray.push(directoryEntry);
  logAuditEvent(State.user?.staffId||'system', State.user?.name||'System', 'Account created', id, `${name.trim()} (${role})`);
  return { id, tempPassword };
}

// Moves a Registrar to a different faculty, or swaps out which person holds
// a faculty's Registrar seat. Updates USERS (the source of truth every
// faculty-scoping check actually reads) and the REGISTRARS directory array
// together, so the People directory never drifts out of sync with reality.
// Mirrors registrar_profiles.faculty_id + assigned_by/assigned_at in the
// real schema — this mock layer is the stand-in for that update statement.
function reassignRegistrar(registrarId, newFacultyKey, assignedByName){
  const user = USERS[registrarId];
  if(!user || user.role !== 'registrar') return false;

  const oldFacultyKey = user.facultyKey;
  user.facultyKey = newFacultyKey;
  user.assignedBy = assignedByName;
  user.assignedAt = Date.now();

  const dirEntry = REGISTRARS.find(r => r.id === registrarId);
  if(dirEntry){
    dirEntry.facultyKey = newFacultyKey;
    dirEntry.dept = facultyName(newFacultyKey);
  }
  return { oldFacultyKey, newFacultyKey };
}

// ============================================================
// FACULTY / PROGRAMME CRUD (Administrator)
// ------------------------------------------------------------
// FACULTIES and PROGRAMMES are the academic structure everything else hangs
// off (student records, Registrar scoping, reports, analytics). Several
// other arrays (FACULTY_COUNTS, PROGRAMME_ANALYTICS, FACULTY_ANALYTICS) were
// pre-computed once from this structure rather than reading it live, so any
// structural change here must explicitly rebuild those — this function is
// the single place that happens, called after every add/edit/delete below.
// ============================================================

function recomputeFacultyProgrammeDerivedData(){
  FACULTY_COUNTS.length = 0;
  FACULTIES.forEach(fac => {
    FACULTY_COUNTS.push({
      key: fac.key, label: fac.name,
      count: STUDENTS.filter(s => s.facultyKey === fac.key).length,
    });
  });

  PROGRAMME_ANALYTICS.length = 0;
  PROGRAMMES.forEach(prog => {
    const progStudents = STUDENTS.filter(s => s.deptKey === prog.key);
    const withPct = progStudents.map(s=>s.pct).filter(p => p !== null && p !== undefined);
    const avg = withPct.length ? Math.round(withPct.reduce((a,b)=>a+b,0) / withPct.length) : 0;
    PROGRAMME_ANALYTICS.push({
      programme: prog.name, facultyKey: prog.facultyKey, faculty: facultyName(prog.facultyKey),
      students: progStudents.length, avgAttendance: avg,
    });
  });

  FACULTY_ANALYTICS.length = 0;
  FACULTIES.forEach(fac => {
    const facStudents = STUDENTS.filter(s => s.facultyKey === fac.key);
    const withPct = facStudents.map(s=>s.pct).filter(p => p !== null && p !== undefined);
    const avg = withPct.length ? Math.round(withPct.reduce((a,b)=>a+b,0) / withPct.length) : 0;
    FACULTY_ANALYTICS.push({
      faculty: fac.name, facultyKey: fac.key,
      students: facStudents.length,
      programmes: PROGRAMMES.filter(p=>p.facultyKey===fac.key).length,
      avgAttendance: avg,
    });
  });
}

function createFaculty(name){
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 24) || `faculty-${Date.now()}`;
  if(FACULTIES.find(f => f.key === key)){
    return { error: 'A faculty with a similar name already exists' };
  }
  FACULTIES.push({ key, name, programmes: [] });
  recomputeFacultyProgrammeDerivedData();
  logAuditEvent(State.user?.staffId||'system', State.user?.name||'System', 'Faculty created', key, name);
  return { key };
}

function renameFaculty(facultyKey, newName){
  const fac = FACULTIES.find(f => f.key === facultyKey);
  if(!fac) return { error: 'Faculty not found' };
  const oldName = fac.name;
  fac.name = newName;
  PROGRAMMES.forEach(p => { if(p.facultyKey === facultyKey) p.facultyName = newName; });
  STUDENTS.forEach(s => { if(s.facultyKey === facultyKey) s.faculty = newName; });
  recomputeFacultyProgrammeDerivedData();
  logAuditEvent(State.user?.staffId||'system', State.user?.name||'System', 'Faculty renamed', facultyKey, `${oldName} → ${newName}`);
  return { ok: true };
}

function deleteFaculty(facultyKey){
  const studentCount = STUDENTS.filter(s => s.facultyKey === facultyKey).length;
  const programmeCount = PROGRAMMES.filter(p => p.facultyKey === facultyKey).length;
  if(studentCount > 0 || programmeCount > 0){
    return { error: `Can't delete — this faculty still has ${programmeCount} programme${programmeCount!==1?'s':''} and ${studentCount} student${studentCount!==1?'s':''}. Remove or reassign those first.` };
  }
  const [regId] = registrarForFaculty(facultyKey) || [];
  if(regId){
    USERS[regId].facultyKey = null;
    const dirEntry = REGISTRARS.find(r => r.id === regId);
    if(dirEntry) dirEntry.facultyKey = null;
  }
  const fac = FACULTIES.find(f => f.key === facultyKey);
  const idx = FACULTIES.findIndex(f => f.key === facultyKey);
  if(idx === -1) return { error: 'Faculty not found' };
  FACULTIES.splice(idx, 1);
  recomputeFacultyProgrammeDerivedData();
  logAuditEvent(State.user?.staffId||'system', State.user?.name||'System', 'Faculty deleted', facultyKey, fac?.name||facultyKey);
  return { ok: true };
}

function createProgramme(facultyKey, name, codePrefix){
  const fac = FACULTIES.find(f => f.key === facultyKey);
  if(!fac) return { error: 'Faculty not found' };
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 16) || `prog-${Date.now()}`;
  if(PROGRAMMES.find(p => p.key === key)){
    return { error: 'A programme with a similar name already exists' };
  }
  const prefix = (codePrefix || name.slice(0,3)).toUpperCase().replace(/[^A-Z]/g,'').padEnd(2,'X').slice(0,4) + 'F';
  PROGRAMMES.push({ facultyKey, facultyName: fac.name, key, name, codePrefix: prefix });
  fac.programmes.push(key);
  recomputeFacultyProgrammeDerivedData();
  return { key };
}

function renameProgramme(programmeKey, newName){
  const prog = PROGRAMMES.find(p => p.key === programmeKey);
  if(!prog) return { error: 'Programme not found' };
  prog.name = newName;
  STUDENTS.forEach(s => { if(s.deptKey === programmeKey) s.dept = newName; });
  recomputeFacultyProgrammeDerivedData();
  return { ok: true };
}

function deleteProgramme(programmeKey){
  const studentCount = STUDENTS.filter(s => s.deptKey === programmeKey).length;
  if(studentCount > 0){
    return { error: `Can't delete — ${studentCount} student${studentCount!==1?'s':''} ${studentCount!==1?'are':'is'} still enrolled in this programme. Move or remove them first.` };
  }
  const idx = PROGRAMMES.findIndex(p => p.key === programmeKey);
  if(idx === -1) return { error: 'Programme not found' };
  const fac = FACULTIES.find(f => f.key === PROGRAMMES[idx].facultyKey);
  PROGRAMMES.splice(idx, 1);
  if(fac) fac.programmes = fac.programmes.filter(k => k !== programmeKey);
  recomputeFacultyProgrammeDerivedData();
  return { ok: true };
}

// ============================================================
// COURSE CATALOG (Administrator)
// ------------------------------------------------------------
// There was no standalone course entity before this — course codes only
// ever existed embedded inside SCHEDULE (the timetable), STUDENT_COURSES,
// LECTURER_COURSES, and historical RECORDS. COURSES is built once from
// SCHEDULE (the most complete existing source: code + name + programme +
// lecturer + room) so Admin manages one real catalog instead of the app
// quietly having four different lists that could disagree with each other.
// New courses added here are catalog-only — they don't auto-create a
// timetable slot, matching how "Create and assign courses" reads versus
// "Schedule Classes" (the Registrar's existing, separate module).
// ============================================================

function buildInitialCourseCatalog(){
  const seen = new Map();
  SCHEDULE.forEach(day => day.lectures.forEach(l => {
    if(!seen.has(l.code)){
      seen.set(l.code, {
        code: l.code, name: l.name, programme: l.dept,
        programmeKey: facultyKeyForProgrammeName(l.dept) ? PROGRAMMES.find(p=>p.name===l.dept)?.key : null,
        lecturer: l.lecturer, room: l.room,
        // Sept 2026 handoff, Part 3: 'day' | 'evening' | null. Null ("no
        // restriction") for every course seeded from SCHEDULE, since SCHEDULE
        // itself has no concept of Day/Evening yet — see the handoff brief's
        // "underlying gap" section. Only newly added/edited courses can set
        // this until SCHEDULE itself grows a real mode field, which is out
        // of scope here (mock SCHEDULE stays as-is, per the brief's judgment call).
        mode: null,
      });
    }
  }));
  return Array.from(seen.values());
}

const COURSES = buildInitialCourseCatalog();

function courseHasDependents(code){
  const inSchedule = SCHEDULE.some(day => day.lectures.some(l => l.code === code));
  const inRecords = RECORDS.some(r => r.code === code);
  return inSchedule || inRecords;
}

function createCourse(code, name, programmeKey, lecturer, room, mode){
  code = code.trim().toUpperCase();
  if(!code || !name.trim()) return { error: 'Course code and name are required' };
  if(COURSES.find(c => c.code === code)) return { error: `${code} already exists in the catalog` };
  const prog = PROGRAMMES.find(p => p.key === programmeKey);
  COURSES.push({
    code, name: name.trim(), programme: prog ? prog.name : null, programmeKey,
    lecturer: lecturer ? lecturer.trim() : null, room: room ? room.trim() : null,
    mode: mode || null, // 'day' | 'evening' | null — see Part 3 note in buildInitialCourseCatalog()
  });
  return { code };
}

function editCourse(code, updates){
  const course = COURSES.find(c => c.code === code);
  if(!course) return { error: 'Course not found' };
  Object.assign(course, updates);
  return { ok: true };
}

// Course code is used as the connecting identifier across the whole mock
// data layer, not just COURSES itself — nothing automatically follows a
// rename, so a course code that just gets swapped in COURSES alone would
// silently orphan every timetable slot, record, and appeal that still
// points at the old string. This walks every one of those places and
// updates the reference in the same action, so nothing goes stale.
function cascadeRenameCourseCode(oldCode, newCode){
  if(!oldCode || !newCode || oldCode === newCode) return 0;
  let touched = 0;

  SCHEDULE.forEach(day => {
    day.lectures.forEach(l => {
      if(l.code === oldCode){ l.code = newCode; touched++; }
    });
  });

  RECORDS.forEach(r => {
    if(r.code === oldCode){ r.code = newCode; touched++; }
  });

  RECENT_SUBMISSIONS.forEach(s => {
    if(s.code === oldCode){ s.code = newCode; touched++; }
  });

  STUDENT_COURSES.forEach(c => {
    if(c.code === oldCode){ c.code = newCode; touched++; }
  });

  LECTURE_OPTIONS.forEach(l => {
    if(l.courseCode === oldCode){
      l.courseCode = newCode;
      l.id = newCode.toLowerCase();
      l.label = l.label.replace(oldCode, newCode);
      touched++;
    }
  });

  // ATTENDANCE_APPEALS stores course as a combined display string, e.g.
  // "CSC3101 — Data Structures & Algorithms" — not a separate code field,
  // so this only swaps the code portion at the start of that string,
  // leaving the course name (and everything else about the appeal) intact.
  ATTENDANCE_APPEALS.forEach(a => {
    if(a.course && a.course.startsWith(oldCode + ' — ')){
      a.course = newCode + a.course.slice(oldCode.length);
      touched++;
    }
  });

  return touched;
}

function deleteCourse(code){
  if(courseHasDependents(code)){
    return { error: `Can't delete ${code} — it has scheduled sessions or attendance records. Remove those first.` };
  }
  const idx = COURSES.findIndex(c => c.code === code);
  if(idx === -1) return { error: 'Course not found' };
  COURSES.splice(idx, 1);
  return { ok: true };
}

// ---------- FORGOT PASSWORD (mocked — wires onto real email/backend later) ----------
// In production this calls something like supabase.auth.resetPasswordForEmail(email)
// and the actual reset happens via a link the person clicks in their inbox. There is
// no email service here yet, so this mock completes instantly and tells the person
// to check their email — it does not reveal whether the address matched an account,
// matching real-world practice (never confirm/deny account existence to a stranger).
function findUserByEmailOrId(identifier){
  const trimmed = identifier.trim().toLowerCase();
  return Object.entries(USERS).find(([id, u]) =>
    id.toLowerCase() === trimmed ||
    ((u.email || vuEmail(u.name)).toLowerCase() === trimmed)
  );
}

let passwordResetTarget = null; // [userId, user] pending a reset, set by the mock "email" step

function requestPasswordReset(identifier){
  const found = findUserByEmailOrId(identifier);
  // Always show the same confirmation regardless of match — don't leak account existence.
  passwordResetTarget = found || null;
  return true;
}

// ---------- REGISTRAR FACULTY-SCOPING HELPERS ----------
// Registrars are faculty-scoped: each one only sees data belonging to their
// own faculty. These helpers resolve a faculty for records that don't store
// facultyKey directly (older mock data keyed by programme name or student name).

function facultyKeyForProgrammeName(programmeName){
  const prog = PROGRAMMES.find(p => p.name === programmeName);
  return prog ? prog.facultyKey : null;
}

function facultyKeyForStudentName(studentName){
  const s = STUDENTS.find(s => s.name === studentName);
  return s ? s.facultyKey : null;
}

// Returns the logged-in Registrar's faculty key, or null if not a faculty-scoped registrar.
function currentRegistrarFacultyKey(){
  return (State.user && State.role === 'registrar') ? State.user.facultyKey : null;
}

function scopedRecords(){
  const fk = currentRegistrarFacultyKey();
  if(!fk) return RECORDS;
  return RECORDS.filter(r => facultyKeyForProgrammeName(r.prog) === fk);
}

function scopedRecentSubmissions(){
  const fk = currentRegistrarFacultyKey();
  if(!fk) return RECENT_SUBMISSIONS;
  return RECENT_SUBMISSIONS.filter(r => facultyKeyForStudentName(r.name) === fk);
}

function scopedAppeals(){
  if(State.role === 'student'){
    // A student must only ever see their own appeals — never classmates'.
    return ATTENDANCE_APPEALS.filter(a => a.student === State.user.name);
  }
  const fk = currentRegistrarFacultyKey();
  if(!fk) return ATTENDANCE_APPEALS;
  return ATTENDANCE_APPEALS.filter(a => facultyKeyForStudentName(a.student) === fk);
}

function scopedSuspicionLog(){
  const fk = currentRegistrarFacultyKey();
  if(!fk) return SUSPICION_LOG;
  return SUSPICION_LOG.filter(s => facultyKeyForStudentName(s.student) === fk);
}

function scopedStudents(){
  const fk = currentRegistrarFacultyKey();
  if(!fk) return STUDENTS;
  return STUDENTS.filter(s => s.facultyKey === fk);
}

// Sept 2026 handoff (Register/Timetable/Records), Part 2: Registrars can now
// reach the Course Catalog too, scoped to their own faculty (courses carry
// programmeKey, not facultyKey directly, so this resolves through PROGRAMMES
// the same way facultyKeyForProgrammeName() does for RECORDS/appeals above).
function scopedCourses(){
  const fk = currentRegistrarFacultyKey();
  if(!fk) return COURSES;
  return COURSES.filter(c => {
    const prog = PROGRAMMES.find(p => p.key === c.programmeKey);
    return prog && prog.facultyKey === fk;
  });
}

function scopedProgrammeAnalytics(){
  const fk = currentRegistrarFacultyKey();
  if(!fk) return PROGRAMME_ANALYTICS;
  return PROGRAMME_ANALYTICS.filter(p => p.facultyKey === fk);
}

function scopedLecturerCompliance(){
  // LECTURER_COMPLIANCE doesn't carry a faculty key (lecturers can span courses);
  // scope it by matching lecturer name against LECTURERS' dept (programme), then
  // resolving that programme's faculty.
  const fk = currentRegistrarFacultyKey();
  if(!fk) return LECTURER_COMPLIANCE;
  return LECTURER_COMPLIANCE.filter(l => {
    const lec = LECTURERS.find(x => x.name === l.lecturer);
    if(!lec || !lec.dept) return false;
    return facultyKeyForProgrammeName(lec.dept) === fk;
  });
}

function showToast(msg, icon){
  const t = document.getElementById('toast');
  t.innerHTML = (icon ? `<span style="display:flex">${icon}</span>` : '') + `<span>${msg}</span>`;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(()=>t.classList.remove('show'), 2200);
}

function openSheet(id){
  document.getElementById('sheetOverlay').classList.add('show');
  document.getElementById(id).classList.add('show');
}
function closeSheet(id){
  document.getElementById('sheetOverlay').classList.remove('show');
  document.getElementById(id).classList.remove('show');
}

// ============================================================
// LOGIN SCREEN
// ============================================================

function renderLogin(){
  return `
  <div class="login-screen" id="loginScreen">
    <div class="login-hero">
      <div class="login-brand-headline">VUSAP</div>
      <div class="login-logo">
        ${VU_LOGO_MARK}
      </div>
      <div class="login-uni-name">VICTORIA UNIVERSITY</div>
      <div class="login-uni-sub">Smart Attendance Portal</div>
    </div>
    <div class="login-form-area">
      <div class="login-card">
        <h1>Welcome back</h1>
        <p class="sub">Sign in to VUSAP</p>
        <form id="loginForm" onsubmit="return handleLogin(event)">
          <div class="field" style="margin-bottom:14px;">
            <label>Email / University ID</label>
            <div class="search-wrap">
              ${ICONS.user}
              <input class="input" style="padding-left:38px;" id="staffId" placeholder="Email or University ID" autocomplete="username" required />
            </div>
          </div>
          <div class="field">
            <label>Password</label>
            <div class="password-wrap">
              <input class="input" type="password" id="password" placeholder="Your password" autocomplete="current-password" required />
              <button type="button" class="eye-btn" onclick="togglePw()" id="eyeBtn">${ICONS.eye}</button>
            </div>
          </div>
          <div style="margin-top:20px;">
            <button class="btn btn-primary" type="submit">Sign In</button>
          </div>
          <div style="text-align:center; margin-top:14px;">
            <a href="#" onclick="renderForgotPasswordRequest(); return false;" style="font-size:12.5px; font-weight:600; color:var(--theme-primary); text-decoration:none;">Forgot password?</a>
          </div>
        </form>
        <div class="demo-box">
          <div class="t" style="cursor:pointer;user-select:none;" onclick="this.parentElement.classList.toggle('demo-open')">
            TEST ACCOUNTS <span id="demoToggleHint" style="font-weight:400;text-transform:none;font-size:10px;color:var(--ink-faint);">(tap to reveal)</span>
          </div>
          <div class="demo-rows-hidden">
            <div class="demo-row" onclick="fillDemo('VU-CSF-2401-0002-DAY','student2026')"><span>Student:</span> <b>...0002-DAY / student2026</b></div>
            <div class="demo-row" onclick="fillDemo('VU-CSF-2401-0001-DAY','student2026')"><span>Student + Coord.:</span> <b>...0001-DAY / student2026</b></div>
            <div class="demo-row" onclick="fillDemo('VU-LEC-101','lecturer2026')"><span>Lecturer:</span> <b>VU-LEC-101 / lecturer2026</b></div>
            <div class="demo-row" onclick="fillDemo('VU-REG-COMP-001','reg2026')"><span>Registrar:</span> <b>...COMP-001 / reg2026</b></div>
            <div class="demo-row" onclick="fillDemo('VU-ADM-001','admin2026')"><span>Administrator:</span> <b>VU-ADM-001 / admin2026</b></div>
          </div>
        </div>
      </div>
      <div class="login-footer">Version 1.0 · VUSAP Attendance Portal &nbsp;·&nbsp; <span id="backendStatus" style="color:var(--ink-faint);">checking…</span></div>
    </div>
  </div>`;
}

function togglePw(){
  const pw = document.getElementById('password');
  const btn = document.getElementById('eyeBtn');
  if(pw.type === 'password'){ pw.type='text'; btn.innerHTML = ICONS.eyeOff; }
  else { pw.type='password'; btn.innerHTML = ICONS.eye; }
}

// ============================================================
// FORCED PASSWORD CHANGE (first login on a temp password)
// ============================================================

function renderForcedPasswordChange(){
  const u = State.user;
  pushAuthScreenState('forcedChange');
  document.getElementById('screens').innerHTML = `<div class="screen active">
  <div class="login-screen">
    <div class="login-hero">
      <div class="login-brand-headline">VUSAP</div>
      <div class="login-logo">
        ${VU_LOGO_MARK}
      </div>
      <div class="login-uni-name">VICTORIA UNIVERSITY</div>
      <div class="login-uni-sub">Smart Attendance Portal</div>
    </div>
    <div class="login-form-area">
      <div class="login-card">
        <h1>Welcome, ${firstName(u.name)}</h1>
        <p class="sub">You're signing in with a temporary password. Choose a password only you know before continuing.</p>
        <form id="forcedPwForm" onsubmit="return submitForcedPasswordChange(event)">
          <div class="field" style="margin-bottom:14px;">
            <label>New Password</label>
            <input class="input" type="password" id="newPw1" placeholder="At least 8 characters" minlength="8" required />
          </div>
          <div class="field">
            <label>Confirm New Password</label>
            <input class="input" type="password" id="newPw2" placeholder="Re-enter password" minlength="8" required />
          </div>
          <div style="margin-top:20px;">
            <button class="btn btn-primary" type="submit">Set Password & Continue</button>
          </div>
        </form>
      </div>
    </div>
  </div>
  </div>`;
  document.getElementById('bottomNav').style.display = 'none';
}

async function submitForcedPasswordChange(e){
  e.preventDefault();
  const pw1 = document.getElementById('newPw1').value;
  const pw2 = document.getElementById('newPw2').value;
  if(pw1.length < 8){
    showToast("Password must be at least 8 characters");
    return false;
  }
  if(pw1 !== pw2){
    showToast("Passwords don't match");
    return false;
  }
  const btn = e.target.querySelector('button[type=submit]');
  if(btn){ btn.disabled = true; btn.textContent = 'Saving…'; }

  const { ok, error } = await authUpdatePassword(pw1);
  if(btn){ btn.disabled = false; btn.textContent = 'Set Password & Continue'; }

  if(!ok){
    showToast(error || 'Could not update password — try again');
    return false;
  }
  // Also update in-memory mock so offline fallback stays consistent.
  if(State.pendingUserId) changePassword(State.pendingUserId, pw1);
  State.pendingUserId = null;
  showToast("Password set. Welcome to VUSAP!");
  boot();
  return false;
}

// ============================================================
// FORGOT PASSWORD (mocked email step — see requestPasswordReset above)
// ============================================================

function renderForgotPasswordRequest(opts){
  opts = opts || {};
  if(!opts.fromPopstate) pushAuthScreenState('forgotRequest');
  document.getElementById('screens').innerHTML = `<div class="screen active">
  <div class="login-screen">
    <div class="login-hero">
      <div class="login-brand-headline">VUSAP</div>
      <div class="login-logo">
        ${VU_LOGO_MARK}
      </div>
      <div class="login-uni-name">VICTORIA UNIVERSITY</div>
      <div class="login-uni-sub">Smart Attendance Portal</div>
    </div>
    <div class="login-form-area">
      <div class="login-card">
        <h1>Reset your password</h1>
        <p class="sub">Enter the email or University ID on your account. We'll send reset instructions if it matches an account.</p>
        <form id="forgotPwForm" onsubmit="return submitForgotPasswordRequest(event)">
          <div class="field" style="margin-bottom:14px;">
            <label>Email / University ID</label>
            <input class="input" id="forgotIdentifier" placeholder="Email or University ID" required />
          </div>
          <div style="margin-top:20px;">
            <button class="btn btn-primary" type="submit">Send Reset Instructions</button>
          </div>
          <div style="text-align:center; margin-top:14px;">
            <a href="#" onclick="renderApp(); return false;" style="font-size:12.5px; font-weight:600; color:var(--theme-primary); text-decoration:none;">Back to Sign In</a>
          </div>
        </form>
      </div>
    </div>
  </div>
  </div>`;
  document.getElementById('bottomNav').style.display = 'none';
}

async function submitForgotPasswordRequest(e){
  e.preventDefault();
  const identifier = document.getElementById('forgotIdentifier').value;
  const btn = e.target.querySelector('button[type=submit]');
  if(btn){ btn.disabled = true; btn.textContent = 'Sending…'; }

  const { ok, live } = await authRequestPasswordReset(identifier);

  if(btn){ btn.disabled = false; btn.textContent = 'Send Reset Instructions'; }

  // For a live reset, Supabase sends a real email — skip the mock demo shortcut.
  renderForgotPasswordSent(identifier, live);
  return false;
}

function renderForgotPasswordSent(identifier, liveReset){
  pushAuthScreenState('forgotSent');
  // liveReset=true: Supabase sent a real email — show a clean confirmation,
  //   no demo shortcut needed (the user clicks the link in their inbox).
  // liveReset=false/undefined: no email service yet — show the demo shortcut
  //   so the prototype flow is still testable without an inbox.
  const matched = !liveReset && !!passwordResetTarget;
  const liveMessage = liveReset
    ? `<div style="font-size:12.5px; color:var(--present); font-weight:600; margin-top:12px; text-align:center;">✓ Real email sent via Supabase</div>`
    : '';
  document.getElementById('screens').innerHTML = `<div class="screen active">
  <div class="login-screen">
    <div class="login-hero">
      <div class="login-brand-headline">VUSAP</div>
      <div class="login-logo">
        ${VU_LOGO_MARK}
      </div>
      <div class="login-uni-name">VICTORIA UNIVERSITY</div>
      <div class="login-uni-sub">Smart Attendance Portal</div>
    </div>
    <div class="login-form-area">
      <div class="login-card">
        <h1>Check your email</h1>
        <div class="empty-state" style="padding:10px 0 6px;">
          ${ICONS.mail.replace(/width="\d+" height="\d+"/,'width="32" height="32"')}
          <div class="t" style="margin-top:14px;">Reset instructions sent</div>
          <div class="s">If ${identifier} matches a VUSAP account, an email with a password reset link is on its way.</div>
        </div>
        ${liveMessage}
        ${matched ? `
        <div class="info-box" style="margin-top:18px; text-align:center;">
          <div class="k">Demo shortcut — no real inbox here</div>
          <div class="v" style="font-size:12.5px;">Running offline. Continue below to simulate clicking the emailed link.</div>
        </div>
        <button class="btn btn-primary" style="margin-top:14px;" onclick="renderResetPasswordForm()">Continue to Reset Password</button>
        ` : ''}
        <div style="text-align:center; margin-top:18px;">
          <a href="#" onclick="renderApp(); return false;" style="font-size:12.5px; font-weight:600; color:var(--theme-primary); text-decoration:none;">Back to Sign In</a>
        </div>
      </div>
    </div>
  </div>
  </div>`;
  document.getElementById('bottomNav').style.display = 'none';
}

function renderResetPasswordForm(){
  if(!passwordResetTarget){ renderApp(); return; }
  pushAuthScreenState('resetForm');
  const [userId, user] = passwordResetTarget;
  document.getElementById('screens').innerHTML = `<div class="screen active">
  <div class="login-screen">
    <div class="login-hero">
      <div class="login-brand-headline">VUSAP</div>
      <div class="login-logo">
        ${VU_LOGO_MARK}
      </div>
      <div class="login-uni-name">VICTORIA UNIVERSITY</div>
      <div class="login-uni-sub">Smart Attendance Portal</div>
    </div>
    <div class="login-form-area">
      <div class="login-card">
        <h1>Hi, ${firstName(user.name)}</h1>
        <p class="sub">Set a new password for ${userId}.</p>
        <form id="resetPwForm" onsubmit="return submitResetPassword(event)">
          <div class="field" style="margin-bottom:14px;">
            <label>New Password</label>
            <input class="input" type="password" id="resetPw1" placeholder="At least 8 characters" minlength="8" required />
          </div>
          <div class="field">
            <label>Confirm New Password</label>
            <input class="input" type="password" id="resetPw2" placeholder="Re-enter password" minlength="8" required />
          </div>
          <div style="margin-top:20px;">
            <button class="btn btn-primary" type="submit">Reset Password</button>
          </div>
        </form>
      </div>
    </div>
  </div>
  </div>`;
  document.getElementById('bottomNav').style.display = 'none';
}

async function submitResetPassword(e){
  e.preventDefault();
  const pw1 = document.getElementById('resetPw1').value;
  const pw2 = document.getElementById('resetPw2').value;
  if(pw1.length < 8){
    showToast("Password must be at least 8 characters");
    return false;
  }
  if(pw1 !== pw2){
    showToast("Passwords don't match");
    return false;
  }
  const btn = e.target.querySelector('button[type=submit]');
  if(btn){ btn.disabled = true; btn.textContent = 'Resetting…'; }

  // Live path: Supabase already has the recovery token from the URL.
  // Mock path: passwordResetTarget holds the [userId, user] pair.
  const { ok, error } = await authUpdatePassword(pw1);
  if(btn){ btn.disabled = false; btn.textContent = 'Reset Password'; }

  if(!ok && !passwordResetTarget){
    showToast(error || 'Could not reset password — try again');
    return false;
  }
  // Keep mock in sync.
  if(passwordResetTarget){
    const [userId] = passwordResetTarget;
    changePassword(userId, pw1);
  }
  passwordResetTarget = null;
  showToast("Password reset. You can now sign in.");
  renderApp();
  return false;
}

function fillDemo(id, pw){
  document.getElementById('staffId').value = id;
  document.getElementById('password').value = pw;
}

async function checkBackendStatus(){
  const el = document.getElementById('backendStatus');
  if(!el) return;
  if(!SUPABASE_CLIENT){
    el.textContent = '⚫ offline mode';
    el.style.color = '#94a3b8';
    return;
  }
  try {
    // Lightweight reachability check — just try to fetch the health endpoint.
    const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: SUPABASE_ANON },
      signal: AbortSignal.timeout(4000),
    });
    if(res.ok){
      el.textContent = '🟢 connected to Supabase';
      el.style.color = 'var(--present)';
      LIVE_BACKEND = true;
    } else {
      el.textContent = '🟡 Supabase unreachable';
      el.style.color = 'var(--late)';
    }
  } catch(e){
    el.textContent = '⚫ offline mode';
    el.style.color = '#94a3b8';
    LIVE_BACKEND = false;
  }
}



async function handleLogin(e){
  e.preventDefault();
  const id = document.getElementById('staffId').value.trim();
  const pw = document.getElementById('password').value;

  // Show a loading state on the button while the async auth call is in flight.
  const btn = e.target.querySelector('button[type=submit]');
  if(btn){ btn.disabled = true; btn.textContent = 'Signing in…'; }

  const { user, role, error } = await authSignIn(id, pw);

  if(btn){ btn.disabled = false; btn.textContent = 'Sign In'; }

  if(error || !user){
    showToast(error || 'Invalid credentials');
    return false;
  }
  if(user.status === 'suspended'){
    showToast("This account has been suspended. Contact your Administrator.");
    return false;
  }
  if(SYSTEM_SETTINGS.maintenanceMode && role !== 'administrator'){
    showToast("VUSAP is under maintenance. Only administrators can log in right now.");
    return false;
  }

  State.role = role;
  State.user = user;
  State.pendingUserId = id;
  // Reset per-session UI state explicitly — without this, State persists
  // across logins in the same browser tab (e.g. testing multiple accounts
  // back to back), so a flag like hasCheckedInToday set true by the
  // PREVIOUS account's check-in would incorrectly carry over and make the
  // new account look like it already checked in without ever scanning.
  State.hasCheckedInToday = false;
  State.checkInVerifying = false;
  State.pinEntry = "";
  State.attendanceDraft = {};
  // Same reasoning, Sept 2026 handoff Part 2: the Student Home banner
  // ticker's cached mode is also shared module-level state.
  _lastStudentBannerMode = null;
  document.getElementById('app').setAttribute('data-role', role);

  // Gate 4: fire-and-forget live enrollments load. Same reasoning as
  // Faculties/Programmes in DOMContentLoaded — every screen reads
  // STUDENT_COURSES fresh on each render, so a later-resolving fetch just
  // takes effect on the next render with no extra wiring, and it silently
  // no-ops for any non-student role or a mock-only login.
  loadEnrollmentsFromSupabase();
  loadNotificationsFromSupabase();
  loadSentNotificationsFromSupabase();
  const mustChange = user.mustChangePassword ?? user.must_change_password ?? false;
  if(mustChange){
    renderForcedPasswordChange();
  } else {
    boot();
  }
  return false;
}

function logout(){
  clearTimeout(_autoLogoutTimer);
  authSignOut(); // fire-and-forget — no need to await before clearing local state
  State.role = null;
  State.user = null;
  State.attendanceDraft = {};
  State.hasCheckedInToday = false;
  State.checkInVerifying = false;
  State.pinEntry = "";
  openSheetId = null;
  // Sept 2026 handoff, Part 2: stop the Student Home banner ticker and drop
  // its cached mode so a fresh login never inherits the previous account's
  // stale comparison state (gotcha: shared module-level state must be reset
  // on both login and logout, or it leaks between accounts).
  stopStudentBannerTicker();
  _lastStudentBannerMode = null;
  // Sept 2026 handoff, Part 4: the Attendance Records catalog's drill-down
  // selections are module-level state too (same reasoning as
  // _lastStudentBannerMode above) — clear them so the next login never
  // opens straight into a faculty/course the new account may not even
  // have access to.
  _recordsCatalogFacultyKey = null;
  _recordsCatalogCourseCode = null;
  renderApp();
}

// ============================================================
// SHARED: STAFF PROFILE (Lecturer, Registrar, Administrator)
// ============================================================

const STAFF_ROLE_META = {
  lecturer:      { label:"Lecturer",      sub:"Course & session management",        icon:ICONS.graduation, backTarget:'dashboard' },
  registrar:      { label:"Registrar",      sub:"Academic operations & oversight",     icon:ICONS.records,    backTarget:'dashboard' },
  administrator:  { label:"Administrator",  sub:"Full system administration",          icon:ICONS.shield,     backTarget:'dashboard' },
};

function renderStaffProfile(){
  const u = State.user;
  const meta = STAFF_ROLE_META[State.role] || { label:"Staff", sub:"", icon:ICONS.user };
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('${meta.backTarget}')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Profile</div>
    </div>
  </div>
  <div class="content">
    <div class="profile-card">
      <div class="profile-avatar-lg">${initials(u.name)}</div>
      <div class="profile-name">${u.name}</div>
      <div class="profile-reg">${u.staffId || ''}</div>
    </div>

    <div class="card card-pad">
      <div class="section-title">${meta.icon} Account Information</div>
      <div class="info-list">
        <div class="info-list-row"><span class="k">${ICONS.user} Full Name</span><span class="v">${u.name}</span></div>
        <div class="info-list-row"><span class="k">${ICONS.pin} Staff ID</span><span class="v">${u.staffId || '—'}</span></div>
        <div class="info-list-row"><span class="k">${meta.icon} Role</span><span class="v">${meta.label}</span></div>
        ${u.dept ? `<div class="info-list-row"><span class="k">${ICONS.building} Department</span><span class="v">${u.dept}</span></div>` : ''}
        ${u.facultyKey ? `<div class="info-list-row"><span class="k">${ICONS.building} Faculty</span><span class="v">${facultyName(u.facultyKey)}</span></div>` : ''}
        <div class="info-list-row"><span class="k">${ICONS.mail} Email</span><span class="v" style="font-size:11.5px;">${vuEmail(u.name)}</span></div>
      </div>
    </div>

    <div class="card card-pad">
      <div class="section-title">${ICONS.settings} Settings</div>
      <div class="info-list">
        <div class="info-list-row">
          <span class="k">${ICONS.moon} Dark Mode</span>
          <div class="toggle-wrap">
            <input type="checkbox" id="darkModeToggle" ${currentTheme === 'dark' ? 'checked' : ''} onchange="toggleDarkMode()">
            <div class="toggle-slider"></div>
          </div>
        </div>
      </div>
    </div>

    <button class="btn btn-ghost" onclick="logout()" style="color:var(--absent); border-color:#fecaca;">${ICONS.logout} Sign Out</button>
  </div>`;
}

// ============================================================
// LECTURER: DASHBOARD
// ============================================================

// Sept 2026 handoff, Part 1: fixes the pre-existing bug where the Lecturer
// Dashboard showed today.lectures[0] — the first lecture in the entire
// university's schedule for that day, unfiltered by who's actually looking
// at it. It only ever coincidentally showed the right course because of
// mock data ordering.
function getLecturerTodayLectures(){
  const today = SCHEDULE.find(d=>d.isToday);
  if(!today || !State.user) return [];
  return today.lectures.filter(l => l.lecturer === State.user.name);
}

function renderLecturerDashboard(){
  const todayLectures = getLecturerTodayLectures();
  const sessionActive = isLiveSessionActive();
  return `
  <div class="app-header">
    <div class="brand-row">
      <div class="brand-id">
        <div class="brand-mark">${VU_LOGO_MARK}</div>
        <div class="brand-text">
          <div class="name">VUSAP</div>
          <div class="sub">Lecturer Portal</div>
        </div>
      </div>
      <div class="header-actions">
        <button class="icon-btn notif-bell-btn" onclick="navigate('notifications')" style="position:relative;">${ICONS.bell}${unreadNotifCount()>0 ? `<span class='notif-badge'>${unreadNotifCount()}</span>` : ''}</button>
        <button class="avatar-chip" onclick="navigate('profile')" title="Profile">${initials(State.user.name)}</button>
      </div>
    </div>
  </div>
  <div class="content">
    <div class="greeting-card">
      <h2>Good evening, ${firstName(State.user.name)}</h2>
      <p>Manage your course sessions and attendance.</p>
      <div class="greeting-tags">
        <span class="tag-pill">${State.user.id || 'VU-LEC-101'}</span>
        <span class="tag-pill">Wednesday</span>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-tile">
        <div class="top"><span class="label">Assigned Courses</span>
          <span class="stat-icon" style="background:#dbeafe; color:#1d4ed8;">${ICONS.book}</span></div>
        <div class="value">${LECTURER_COURSES.length}</div>
      </div>
      <div class="stat-tile">
        <div class="top"><span class="label">Attendance Rate</span>
          <span class="stat-icon" style="background:#dcfce7; color:#16a34a;">${ICONS.trend}</span></div>
        <div class="value">87%</div>
      </div>
      <div class="stat-tile">
        <div class="top"><span class="label">Today's Classes</span>
          <span class="stat-icon" style="background:#ffedd5; color:#c2410c;">${ICONS.clock}</span></div>
        <div class="value">${todayLectures.length}</div>
      </div>
      <div class="stat-tile">
        <div class="top"><span class="label">Records Today</span>
          <span class="stat-icon" style="background:#f3e8ff; color:#9333ea;">${ICONS.check}</span></div>
        <div class="value">0</div>
      </div>
    </div>

    <div class="card section-card">
      <div class="section-title">${ICONS.chart} Attendance Overview</div>
      ${donutChart([
        {label:'Present', value:10, color:'#16a34a'},
        {label:'Late', value:3, color:'#d97706'},
        {label:'Absent', value:2, color:'#dc2626'},
      ])}
    </div>

    <div class="card section-card">
      <div class="section-head-row">
        <div class="section-title" style="margin-bottom:0;">${ICONS.clock} Today's Lectures</div>
      </div>
      ${lectureListMarkup(todayLectures, sessionActive)}
    </div>

    <a class="quick-action solid" onclick="handleStartLiveSessionTap()">
      <div class="qa-icon">${ICONS.qrcode}</div>
      <div class="qa-text"><div class="t">Start Live Session</div><div class="s">Generate QR & PIN for student check-in</div></div>
      <div class="chev">${ICONS.chevR}</div>
    </a>
    <a class="quick-action" onclick="navigate('markAttendance')">
      <div class="qa-icon">${ICONS.check}</div>
      <div class="qa-text"><div class="t">Attendance Corrections</div><div class="s">Submit manual corrections for a session</div></div>
      <div class="chev">${ICONS.chevR}</div>
    </a>
    <a class="quick-action" onclick="navigate('schedule')">
      <div class="qa-icon">${ICONS.calendar}</div>
      <div class="qa-text"><div class="t">My Timetable</div><div class="s">View all assigned lectures</div></div>
      <div class="chev">${ICONS.chevR}</div>
    </a>
    <a class="quick-action" onclick="navigate('announcements')">
      <div class="qa-icon">${ICONS.megaphone}</div>
      <div class="qa-text"><div class="t">Announcements</div><div class="s">Post updates to your courses</div></div>
      <div class="chev">${ICONS.chevR}</div>
    </a>
    <a class="quick-action" onclick="navigate('attendanceCatalog')">
      <div class="qa-icon">${ICONS.records}</div>
      <div class="qa-text"><div class="t">Attendance Records</div><div class="s">Browse records by course</div></div>
      <div class="chev">${ICONS.chevR}</div>
    </a>
    <a class="quick-action" onclick="navigate('reports')">
      <div class="qa-icon">${ICONS.fileText}</div>
      <div class="qa-text"><div class="t">Export Course Attendance</div><div class="s">PDF / Excel for your courses</div></div>
      <div class="chev">${ICONS.chevR}</div>
    </a>
  </div>

  <div class="sheet" id="startSessionPickerSheet">
    <div class="sheet-handle"></div>
    <div class="sheet-title">
      <span>Which lecture?</span>
      <button onclick="closeSheet('startSessionPickerSheet')">${ICONS.close}</button>
    </div>
    <div style="font-size:11.5px; color:var(--ink-faint); margin:-6px 0 12px;">You have more than one lecture today — pick which one to start a live session for.</div>
    <div style="display:flex; flex-direction:column; gap:10px;">
      ${lectureListMarkup(todayLectures, false, { sheetPicker:true })}
    </div>
  </div>`;
}

// Shared renderer for the Today's Lectures list, used both on the dashboard
// card and inside the "which lecture?" picker sheet (Sept 2026 handoff,
// Part 1) — one function so the two views of the same data can't drift.
// - Before any session is active: every row is tappable and starts a live
//   session for that lecture directly (this doubles as the picker when
//   opts.sheetPicker is true, and as the one-tap common case otherwise).
// - Once a session is genuinely active (isLiveSessionActive()): the active
//   lecture's row is highlighted "Live"; every other row is visually
//   disabled with no click handler, so a second course's session can't be
//   started by accident while one is already running.
function lectureListMarkup(lectures, sessionActive, opts){
  opts = opts || {};
  if(!lectures.length) return `<div class="empty-state"><div class="t">No lectures today</div></div>`;
  return lectures.map(l => {
    const isLiveOne = sessionActive && l.code === LIVE_SESSION.courseCode && l.mode === LIVE_SESSION.mode;
    const isDisabled = sessionActive && !isLiveOne;
    const closeAttr = opts.sheetPicker ? "closeSheet('startSessionPickerSheet');" : '';
    const clickAttr = isDisabled ? '' : `onclick="${closeAttr}handleLectureRowTap('${l.code}')"`;
    return `
      <div class="lecture-row" style="${isDisabled ? 'opacity:.45;' : 'cursor:pointer;'}" ${clickAttr}>
        <div>
          <div class="lecture-code">${l.code}</div>
          <div class="lecture-name">${l.name}</div>
          <div class="lecture-meta">${ICONS.clock}${l.time} · ${l.room}</div>
        </div>
        <span class="badge ${isLiveOne ? 'today' : 'pending'}">${isLiveOne ? 'Live' : 'Pending'}</span>
      </div>`;
  }).join('');
}

function donutChart(segments){
  const total = segments.reduce((s,x)=>s+x.value,0);
  let cumulative = 0;
  const r = 54, cx=64, cy=64, sw=18;
  const circumference = 2*Math.PI*r;
  const arcs = segments.map(seg=>{
    const frac = seg.value/total;
    const dash = frac*circumference;
    const gap = circumference - dash;
    const offset = circumference*0.25 - (cumulative*circumference); // start at top
    cumulative += frac;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="${sw}"
      stroke-dasharray="${dash} ${gap}" stroke-dashoffset="${offset}" stroke-linecap="butt" transform="rotate(-90 ${cx} ${cy})" />`;
  }).join('');
  const legend = segments.map(seg=>`<div><span class="legend-dot" style="background:${seg.color}"></span>${seg.label} (${seg.value})</div>`).join('');
  return `
  <div class="donut-wrap">
    <svg width="128" height="128" viewBox="0 0 128 128">${arcs}</svg>
    <div class="donut-legend">${legend}</div>
  </div>`;
}

// ============================================================
// LECTURER: ATTENDANCE CORRECTIONS (manual override for a session)
// ============================================================

const LECTURE_OPTIONS = [
  { id:'csc3101', label:'CSC3101 – Data Structures & Algorithms (Monday 08:00)', courseCode:'CSC3101', courseName:'Data Structures & Algorithms', lecturer:'Dr. Patrick Mukasa', room:'LT1 - Main Building', dayTime:'Monday · 08:00 – 10:00' },
  { id:'csc3103', label:'CSC3103 – Software Engineering (Wednesday 08:00)', courseCode:'CSC3103', courseName:'Software Engineering', lecturer:'Dr. Patrick Mukasa', room:'LT1 - Main Building', dayTime:'Wednesday · 08:00 – 10:00' },
];

let currentLectureId = 'csc3103';

function getSessionStudents(){
  return STUDENTS.filter(s=>s.deptKey==='cs').slice(0,10);
}

function renderMarkAttendance(){
  const lec = LECTURE_OPTIONS.find(l=>l.id===currentLectureId);
  const students = getSessionStudents();
  const counts = {p:0,l:0,a:0};
  students.forEach(s=>{ const v = State.attendanceDraft[s.id]; if(v) counts[v]++; });
  const unmarked = students.length - counts.p - counts.l - counts.a;

  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('dashboard')">${ICONS.back}</button>
      <div>
        <div class="page-title" style="font-size:18px;">Attendance Corrections</div>
      </div>
    </div>
  </div>
  <div class="content" style="padding-bottom:90px;">
    <div class="card card-pad">
      <div class="field" style="margin-bottom:14px;">
        <label>Select Lecture</label>
        <select class="select" onchange="changeLecture(this.value)">
          ${LECTURE_OPTIONS.map(l=>`<option value="${l.id}" ${l.id===currentLectureId?'selected':''}>${l.label}</option>`).join('')}
        </select>
      </div>
      <div class="field" style="margin-bottom:14px;">
        <label>Session Date</label>
        <input class="input" type="text" value="24-Jun-2026" readonly />
      </div>
      <div class="info-box">
        <div class="k">${lec.courseCode} — ${lec.courseName}</div>
        <div class="v" style="font-size:12px;">${lec.lecturer} · ${lec.room}</div>
        <div style="font-size:11px;color:var(--ink-faint);margin-top:3px;">${lec.dayTime}</div>
      </div>
    </div>

    <div class="status-chip-grid">
      <div class="status-chip present"><div class="n">${counts.p}</div><div class="l">Present</div></div>
      <div class="status-chip late"><div class="n">${counts.l}</div><div class="l">Late</div></div>
      <div class="status-chip absent"><div class="n">${counts.a}</div><div class="l">Absent</div></div>
      <div class="status-chip unmarked"><div class="n">${unmarked}</div><div class="l">Unmarked</div></div>
    </div>

    <div class="card card-pad">
      <div class="search-wrap" style="margin-bottom:12px;">
        ${ICONS.search}
        <input class="input" id="studentSearch" placeholder="Search student name or ID..." oninput="filterAttendanceList(this.value)" />
      </div>
      <div style="font-size:11px;font-weight:700;color:var(--ink-faint);margin-bottom:8px;">MARK ALL AS</div>
      <div class="markall-row">
        <button class="markall-btn present" onclick="markAll('p')">Present</button>
        <button class="markall-btn late" onclick="markAll('l')">Late</button>
        <button class="markall-btn absent" onclick="markAll('a')">Absent</button>
      </div>
      <div id="attendanceList" style="margin-top:8px; max-height:50vh; overflow-y:auto; -webkit-overflow-scrolling:touch;">
        ${students.map(s=>studentAttendanceRow(s)).join('')}
      </div>
    </div>
  </div>
  <div class="sticky-footer">
    <div class="sticky-footer-inner">
      ${unmarked>0 ? `<div style="font-size:11.5px;color:var(--late);font-weight:600;margin-bottom:10px;text-align:center;">⚠ ${unmarked} student${unmarked>1?'s':''} not yet marked</div>` : ''}
      <button class="btn btn-primary" onclick="submitAttendance()">${ICONS.check} Submit Corrections</button>
    </div>
  </div>`;
}

function studentAttendanceRow(s){
  const v = State.attendanceDraft[s.id];
  return `
  <div class="student-row" data-student-row data-name="${s.name.toLowerCase()}" data-reg="${s.reg.toLowerCase()}">
    <div class="avatar">${initials(s.name)}</div>
    <div class="student-info">
      <div class="student-name">${s.name}</div>
      <div class="student-meta">${s.reg}</div>
    </div>
    <div class="pla-toggle">
      <button class="pla-btn p ${v==='p'?'on':''}" onclick="setAttendance(${s.id},'p')">P</button>
      <button class="pla-btn l ${v==='l'?'on':''}" onclick="setAttendance(${s.id},'l')">L</button>
      <button class="pla-btn a ${v==='a'?'on':''}" onclick="setAttendance(${s.id},'a')">A</button>
    </div>
  </div>`;
}

function setAttendance(id, val){
  if(State.attendanceDraft[id] === val){
    delete State.attendanceDraft[id];
  } else {
    State.attendanceDraft[id] = val;
  }
  rerenderCurrentScreen();
}

function markAll(val){
  getSessionStudents().forEach(s=>{ State.attendanceDraft[s.id] = val; });
  rerenderCurrentScreen();
  showToast(`All students marked ${val==='p'?'Present':val==='l'?'Late':'Absent'}`);
}

function changeLecture(id){
  currentLectureId = id;
  State.attendanceDraft = {};
  rerenderCurrentScreen();
}

function toggleNoResultsState(containerId, visibleCount, message){
  let el = document.getElementById(containerId + 'NoResults');
  const container = document.getElementById(containerId);
  if(!container) return;
  if(visibleCount === 0){
    if(!el){
      el = document.createElement('div');
      el.id = containerId + 'NoResults';
      el.className = 'empty-state';
      el.style.padding = '24px 10px';
      el.innerHTML = `${ICONS.search.replace(/width="\d+" height="\d+"/,'width="32" height="32"')}<div class="t">No matches found</div><div class="s">${message || 'Try a different search term'}</div>`;
      container.appendChild(el);
    }
    el.style.display = 'block';
  } else if(el){
    el.style.display = 'none';
  }
}

function filterAttendanceList(q){
  q = q.toLowerCase();
  let visible = 0;
  document.querySelectorAll('[data-student-row]').forEach(row=>{
    const match = row.dataset.name.includes(q) || row.dataset.reg.includes(q);
    row.style.display = match ? 'flex' : 'none';
    if(match) visible++;
  });
  toggleNoResultsState('attendanceList', visible, 'Try searching a different name or ID');
}

function submitAttendance(){
  const lec = LECTURE_OPTIONS.find(l=>l.id===currentLectureId);
  const students = getSessionStudents();
  const marked = students.filter(s=>State.attendanceDraft[s.id]);
  if(marked.length === 0){
    showToast("Mark at least one student before submitting");
    return;
  }
  // This previously only showed a success toast and discarded the draft —
  // nothing was ever actually written anywhere, which is why a submitted
  // correction never showed up in the Registrar's Recent Submissions or in
  // the student's own attendance record. Mock-layer only, consistent with
  // STUDENTS/COURSES/SCHEDULE/RECORDS all being mock throughout this app —
  // this doesn't reach live Supabase attendance rows.
  const statusMap = { p:'present', l:'late', a:'absent' };
  const today = new Date().toISOString().slice(0,10);
  marked.forEach(s => {
    const status = statusMap[State.attendanceDraft[s.id]];
    RECENT_SUBMISSIONS.unshift({ name: s.name, code: lec.courseCode, date: today, status });
    RECORDS.unshift({
      date: today, reg: s.reg, name: s.name, prog: s.dept,
      code: lec.courseCode, course: lec.courseName, venue: lec.room, status,
    });
  });
  showToast(`Attendance submitted for ${marked.length} of ${students.length} students`, ICONS.checkCircle.replace('width="64" height="64"','width="16" height="16"'));
  setTimeout(()=>{ State.attendanceDraft = {}; navigate('dashboard'); }, 900);
}

// ============================================================
// LECTURER: MY TIMETABLE  (also reused for Registrar "All Schedules")
// ============================================================

function renderSchedule(opts){
  opts = opts || {};
  const title = opts.title || "My Lecture Schedule";
  const subtitle = opts.subtitle || "Weekly timetable overview";
  const showDeptFilter = !!opts.showDeptFilter;
  const backTarget = opts.backTarget || 'dashboard';
  // Registrar-only: the "Create New Class Session" action formerly lived on
  // its own "Schedule Classes" dashboard row — it now lives here, on the
  // Schedules bottom-nav tab, since that's the screen it actually edits.
  const showCreateSession = !!opts.showCreateSession;
  // Lecturer-only, opt-in: splits the week into Day / Evening sections
  // instead of one flat per-day list. Not applied to Student (they already
  // only ever see their own single mode, via filterLecturesForStudentMode()
  // — sectioning would just leave one section empty) or Registrar (their
  // Schedules tab is also editable, and this view is read-only-only, see
  // below) unless a future request asks for it there too.
  const groupByMode = !!opts.groupByMode;

  const scheduleBody = groupByMode
    ? ['day','evening'].map(mode => {
        const label = mode === 'day' ? 'Day Sessions' : 'Evening Sessions';
        const daysForMode = SCHEDULE
          .map(d => ({ ...d, lectures: d.lectures.filter(l => l.mode === mode) }))
          .filter(d => d.lectures.length > 0);
        return `
        <div class="section-title" style="margin:18px 0 8px;">${mode==='day'?ICONS.clock:ICONS.calendar} ${label}</div>
        ${daysForMode.length
          ? daysForMode.map(d=>scheduleDayGroup(d, showDeptFilter, showCreateSession, SCHEDULE.find(sd => sd.day === d.day))).join('')
          : `<div class="empty-state-sm">No ${mode} sessions scheduled</div>`}
      `;
      }).join('') + (() => {
        // Slots with no mode set yet — surfaced separately rather than
        // silently dropped from both sections above, so it's obvious which
        // lectures still need a mode assigned.
        const unset = SCHEDULE
          .map(d => ({ ...d, lectures: d.lectures.filter(l => !l.mode) }))
          .filter(d => d.lectures.length > 0);
        return unset.length ? `
        <div class="section-title" style="margin:18px 0 8px;">${ICONS.alertTriangle} Mode Not Set</div>
        ${unset.map(d=>scheduleDayGroup(d, showDeptFilter, showCreateSession, SCHEDULE.find(sd => sd.day === d.day))).join('')}
        ` : '';
      })()
    : SCHEDULE.map(d=>scheduleDayGroup(d, showDeptFilter, showCreateSession)).join('');

  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('${backTarget}')">${ICONS.back}</button>
      <div>
        <div class="page-title" style="font-size:18px;">${title}</div>
      </div>
    </div>
  </div>
  <div class="content" style="${showCreateSession ? 'padding-bottom:90px;' : ''}">
    <div class="search-wrap">
      ${ICONS.search}
      <input class="input" placeholder="Search course, lecturer or venue..." oninput="filterSchedule(this.value)" id="scheduleSearch" />
    </div>
    <div class="field-row">
      <div class="field">
        <select class="select" id="dayFilter" onchange="filterSchedule()">
          <option value="">All Days</option>
          ${SCHEDULE.map(d=>`<option value="${d.day}">${d.day}</option>`).join('')}
        </select>
      </div>
      ${showDeptFilter ? `
      <div class="field">
        <select class="select" id="deptFilter" onchange="filterSchedule()">
          <option value="">All Departments</option>
          <option value="Computer Science">Computer Science</option>
          <option value="Business Administration">Business Administration</option>
          <option value="Civil Engineering">Civil Engineering</option>
        </select>
      </div>` : ''}
    </div>
    <div id="scheduleList">
      ${scheduleBody}
    </div>
  </div>
  ${showCreateSession ? `
  <div class="sticky-footer">
    <div class="sticky-footer-inner" style="padding:8px;">
      <button class="btn btn-primary" onclick="openNewSessionSheet()">${ICONS.plus} Create New Class Session</button>
    </div>
  </div>

  <div class="sheet" id="newSessionSheet">
    <div class="sheet-handle"></div>
    <div class="sheet-title">
      <span id="newSessionSheetTitle">New Class Session</span>
      <button onclick="closeSheet('newSessionSheet')">${ICONS.close}</button>
    </div>
    <div id="newSessionBody">${renderNewSessionFormBody()}</div>
  </div>` : ''}`;
}

// Sept 2026 handoff (Register/Timetable/Records), Part 2: `editable` (true
// only on the showCreateSession screens — Administrator/Registrar's "All
// Schedules") adds real per-slot edit/delete, not just the existing
// create-only flow. SCHEDULE lectures aren't uniquely keyed (the same course
// code can legitimately appear on more than one day), so slots are targeted
// by (day, index within that day) rather than by code — recomputed fresh on
// every re-render, so it stays correct even as slots are added/removed.
function scheduleDayGroup(d, showDept, editable, originalDay = null){
  // If originalDay is provided, use it to find correct indices in the unfiltered array
  const sourceDay = originalDay || d;
  
  return `
  <div class="day-group" data-day-group data-day="${d.day}">
    <div class="day-header ${d.isToday?'today-day':''}">
      <span>${ICONS.calendar.replace('viewBox="0 0 24 24"','viewBox="0 0 24 24" width="14" height="14" style="margin-right:6px;vertical-align:-2px;"')}${d.day} ${d.isToday?'<span class="badge today" style="margin-left:6px;">Today</span>':''}</span>
      <span class="day-count">${d.lectures.length} lecture${d.lectures.length>1?'s':''}</span>
    </div>
    <div class="card card-pad" style="display:flex;flex-direction:column;gap:10px;">
      ${d.lectures.map((l,i)=>`
      <div class="lecture-row" data-lecture-row data-dept="${l.dept}" data-search="${(l.code+' '+l.name+' '+l.lecturer+' '+l.room).toLowerCase()}">
        <div>
          <div class="lecture-code">${l.code} <span class="badge dept ${l.dept.includes('Business')?'biz':l.dept.includes('Engineering')?'eng':''}" style="margin-left:4px;">${l.dept.split(' ')[0]}</span>${l.mode ? `<span class="badge dept" style="margin-left:4px;background:#f1f5f9;color:#64748b;">${l.mode==='day'?'Day':'Evening'}</span>` : ''}</div>
          <div class="lecture-name">${l.name}</div>
          <div class="lecture-meta">${ICONS.user} ${l.lecturer}</div>
          <div class="lecture-meta">${ICONS.pin} ${l.room}</div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div class="lecture-meta" style="margin-top:0;font-weight:700;color:var(--ink-soft);">${l.time}</div>
          ${l.status==='pending' ? '<span class="badge pending" style="margin-top:8px;display:inline-block;">Pending</span>' : ''}
          ${editable ? `
          <div style="display:flex;gap:6px;margin-top:8px;justify-content:flex-end;">
            <button class="icon-btn" style="width:28px;height:28px;background:var(--unmarked-bg);" onclick="event.stopPropagation();openNewSessionSheet('${sourceDay.day}', ${sourceDay.lectures.findIndex(sl => sl.code === l.code && sl.room === l.room && sl.time === l.time)})" title="Edit">${ICONS.edit.replace(/<svg /,'<svg style="width:12px;height:12px;" ')}</button>
            <button class="icon-btn" style="width:28px;height:28px;background:#fee2e2;color:#b91c1c;" onclick="event.stopPropagation();confirmDeleteSlot('${sourceDay.day}', ${sourceDay.lectures.findIndex(sl => sl.code === l.code && sl.room === l.room && sl.time === l.time)})" title="Delete">${ICONS.close.replace(/<svg /,'<svg style="width:12px;height:12px;" ')}</button>
          </div>` : ''}
        </div>
      </div>`).join('')}
      ${!d.lectures.length ? `<div style="font-size:12px;color:var(--ink-faint);padding:6px 2px;">No sessions scheduled</div>` : ''}
    </div>
  </div>`;
}

function filterSchedule(){
  const q = (document.getElementById('scheduleSearch')?.value || '').toLowerCase();
  const day = document.getElementById('dayFilter')?.value || '';
  const dept = document.getElementById('deptFilter')?.value || '';

  let anyGroupVisible = false;
  document.querySelectorAll('[data-day-group]').forEach(group=>{
    const dayMatch = !day || group.dataset.day === day;
    let anyVisible = false;
    group.querySelectorAll('[data-lecture-row]').forEach(row=>{
      const textMatch = !q || row.dataset.search.includes(q);
      const deptMatch = !dept || row.dataset.dept === dept;
      const visible = textMatch && deptMatch;
      row.style.display = visible ? 'flex' : 'none';
      if(visible) anyVisible = true;
    });
    const groupVisible = dayMatch && anyVisible;
    group.style.display = groupVisible ? 'block' : 'none';
    if(groupVisible) anyGroupVisible = true;
  });
  toggleNoResultsState('scheduleList', anyGroupVisible ? 1 : 0, 'Try a different search, day, or department');
}

// ============================================================
// SHARED: REGISTER (Administrator/Registrar/Lecturer)
// ------------------------------------------------------------
// Sept 2026 handoff, Part 1: renderStudents() (Admin/Registrar student list),
// renderStaffDirectory() (Admin read-only People catalog) and
// renderUserManagement() (Admin account lifecycle) have been merged into one
// screen — Register — scoped per role below. renderRegister() and its
// supporting functions live further down (just before "STUDENT: HOME"), once
// the enroll-sheet plumbing they depend on (renderEnrollFormBody, handleEnroll,
// etc, kept below) has been defined.
// ============================================================

let regNoCounter = 522;

function renderEnrollFormBody(){
  return `
    <div style="font-size:12px;color:var(--ink-soft);margin:-8px 0 16px;">Fill in the student details below</div>
    <form id="enrollForm" onsubmit="return handleEnroll(event)" style="display:flex;flex-direction:column;gap:14px;">
      <div class="info-box">
        <div class="k">Registration No. (auto-generated)</div>
        <div class="v" id="regNoPreview">VU-${PROGRAMMES[0].codePrefix}-2601-${String(regNoCounter).padStart(4,'0')}-DAY</div>
      </div>
      <div class="field">
        <label>Full Name <span class="req">*</span></label>
        <input class="input" id="enrollName" placeholder="e.g. Aisha Nakamya" required />
      </div>
      <div class="field">
        <label>Email Address <span class="req">*</span></label>
        <input class="input" type="email" id="enrollEmail" placeholder="e.g. a.nakamya@vu.ac.ug" required />
      </div>
      <div class="field">
        <label>Faculty / Programme <span class="req">*</span></label>
        <select class="select" id="enrollDept" onchange="updateRegPreview()">
          ${(State.role === 'registrar' ? FACULTIES.filter(f=>f.key===currentRegistrarFacultyKey()) : FACULTIES).map(fac => `
          <optgroup label="${fac.name}">
            ${PROGRAMMES.filter(p=>p.facultyKey===fac.key).map(p=>`<option value="${p.key}">${p.name}</option>`).join('')}
          </optgroup>`).join('')}
        </select>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Year of Study <span class="req">*</span></label>
          <select class="select" id="enrollYear">
            <option>Year 1</option><option>Year 2</option><option>Year 3</option>
          </select>
        </div>
        <div class="field">
          <label>Study Mode <span class="req">*</span></label>
          <select class="select" id="enrollMode" onchange="updateRegPreview()">
            <option value="DAY">DAY</option><option value="EVE">EVENING</option>
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Gender <span class="req">*</span></label>
          <select class="select" id="enrollGender">
            <option value="Male">Male</option><option value="Female">Female</option>
          </select>
        </div>
        <div class="field">
          <label>Semester <span class="req">*</span></label>
          <select class="select" id="enrollSemester">
            <option value="Semester 1">Semester 1</option><option value="Semester 2">Semester 2</option>
          </select>
        </div>
      </div>
      <div class="btn-row" style="margin-top:6px;">
        <button type="button" class="btn btn-ghost" onclick="closeSheet('enrollSheet')">Cancel</button>
        <button type="submit" class="btn btn-primary">${ICONS.check} Enroll Student</button>
      </div>
    </form>`;
}

function studentRegisterRow(s){
  const hasPct = s.pct !== null;
  const cls = hasPct ? (s.pct >= ATTENDANCE_POLICIES.minAttendancePct ? 'good' : 'bad') : '';
  const deptBadgeCls = palClass(s.deptKey, PROGRAMMES.map(p=>p.key));
  return `
  <div class="student-card-row" data-student-card data-name="${s.name.toLowerCase()}" data-reg="${s.reg.toLowerCase()}" data-dept="${s.dept}" data-faculty="${s.facultyKey}" data-year="${s.year}">
    <div class="avatar">${initials(s.name)}</div>
    <div class="student-info">
      <div class="student-name">${s.name}</div>
      <div class="student-meta">${s.reg} · ${s.year || '—'} · ${s.gender || '—'} · ${s.semester || '—'}</div>
      <span class="badge dept ${deptBadgeCls}" style="margin-top:4px;display:inline-block;">${s.dept}</span>
    </div>
    ${hasPct ? `
    <div class="attendance-pct ${cls}">${s.trend==='up'?'↑':'↓'} ${s.pct}%<span class="lbl">attendance</span></div>
    ` : `<div class="attendance-pct" style="color:var(--ink-faint);font-weight:600;font-size:11px;">no records</div>`}
    <button class="icon-btn" style="width:32px;height:32px;flex-shrink:0;background:var(--surface);border:1.5px solid var(--line);color:var(--theme-primary);border-radius:var(--radius-sm);" title="Edit gender / semester" onclick="event.stopPropagation();openEditStudentSheet('${s.id}')">${ICONS.edit || ICONS.settings}</button>
  </div>`;
}

// Opens a lightweight edit sheet for a single student's gender/semester —
// the only two attributes an Admin/Registrar can currently set beyond what
// Enroll Student already captures. Ids are always passed through as quoted
// strings here (never interpolated bare into onclick) and compared with
// String(...) below, so this keeps working the moment STUDENTS ids stop
// being small mock integers and become real Supabase UUIDs (see the Appeals
// bug this exact pattern caused previously).
function openEditStudentSheet(studentId){
  const s = STUDENTS.find(x => String(x.id) === String(studentId));
  if(!s){ showToast('Student not found'); return; }
  const body = document.getElementById('editStudentBody');
  if(body) body.innerHTML = renderEditStudentFormBody(s);
  openSheet('editStudentSheet');
}

// Sept 2026 handoff, Part 1: expanded from Gender/Semester-only to cover
// name, email, faculty/programme, year, mode, gender and semester — a
// Register profile edit, not just the two attributes Enroll Student didn't
// already ask for. The registration number itself is deliberately NOT
// editable here (it's the USERS/STUDENTS join key and appears verbatim in
// RECORDS) — changing programme updates the student's faculty/dept/deptKey
// but leaves their existing reg number as-is, same as a real transfer
// wouldn't re-mint a student's ID.
function renderEditStudentFormBody(s){
  return `
    <div style="font-size:12px;color:var(--ink-soft);margin:-8px 0 16px;">${s.reg}</div>
    <form id="editStudentForm" onsubmit="return submitEditStudent(event, '${s.id}')" style="display:flex;flex-direction:column;gap:14px;">
      <div class="field">
        <label>Full Name <span class="req">*</span></label>
        <input class="input" id="editStudentName" value="${s.name}" required />
      </div>
      <div class="field">
        <label>Email Address</label>
        <input class="input" type="email" id="editStudentEmail" value="${s.email || ''}" />
      </div>
      <div class="field">
        <label>Faculty / Programme</label>
        <select class="select" id="editStudentDept">
          ${FACULTIES.map(fac => `
          <optgroup label="${fac.name}">
            ${PROGRAMMES.filter(p=>p.facultyKey===fac.key).map(p=>`<option value="${p.key}" ${s.deptKey===p.key?'selected':''}>${p.name}</option>`).join('')}
          </optgroup>`).join('')}
        </select>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Year of Study</label>
          <select class="select" id="editStudentYear">
            <option value="" ${!s.year?'selected':''}>— Not set —</option>
            <option ${s.year==='Year 1'?'selected':''}>Year 1</option>
            <option ${s.year==='Year 2'?'selected':''}>Year 2</option>
            <option ${s.year==='Year 3'?'selected':''}>Year 3</option>
          </select>
        </div>
        <div class="field">
          <label>Study Mode</label>
          <select class="select" id="editStudentMode">
            <option value="day" ${s.mode==='day'?'selected':''}>Day</option>
            <option value="evening" ${s.mode==='evening'?'selected':''}>Evening</option>
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Gender</label>
          <select class="select" id="editStudentGender">
            <option value="Male" ${s.gender==='Male'?'selected':''}>Male</option>
            <option value="Female" ${s.gender==='Female'?'selected':''}>Female</option>
          </select>
        </div>
        <div class="field">
          <label>Semester</label>
          <select class="select" id="editStudentSemester">
            <option value="Semester 1" ${s.semester==='Semester 1'?'selected':''}>Semester 1</option>
            <option value="Semester 2" ${s.semester==='Semester 2'?'selected':''}>Semester 2</option>
          </select>
        </div>
      </div>
      <div style="font-size:11px;color:var(--ink-faint);line-height:1.5;">Registration number stays ${s.reg} even if programme changes.</div>
      <div class="btn-row" style="margin-top:6px;">
        <button type="button" class="btn btn-ghost" onclick="closeSheet('editStudentSheet')">Cancel</button>
        <button type="submit" class="btn btn-primary">${ICONS.check} Save</button>
      </div>
    </form>`;
}

function submitEditStudent(e, studentId){
  e.preventDefault();
  const s = STUDENTS.find(x => String(x.id) === String(studentId));
  if(!s) return false;
  const name = document.getElementById('editStudentName')?.value.trim();
  if(!name){ showToast('Enter a full name'); return false; }
  const email = document.getElementById('editStudentEmail')?.value.trim();
  const progKey = document.getElementById('editStudentDept')?.value;
  const prog = PROGRAMMES.find(p => p.key === progKey);

  s.name = name;
  s.email = email || vuEmail(name);
  if(prog){ s.dept = prog.name; s.deptKey = prog.key; s.facultyKey = prog.facultyKey; s.faculty = prog.facultyName; }
  s.year = document.getElementById('editStudentYear').value || null;
  s.mode = document.getElementById('editStudentMode').value;
  s.gender = document.getElementById('editStudentGender').value;
  s.semester = document.getElementById('editStudentSemester').value;

  // Keep the login record (USERS) in sync — resolveCheckInOutcome()'s
  // Day/Evening mismatch check reads State.user.mode live off this record,
  // not off STUDENTS, so an edit here that didn't also update USERS would
  // silently stop affecting check-in behavior.
  const account = USERS[s.reg];
  if(account){
    account.name = name; account.email = s.email; account.dept = s.dept;
    account.year = s.year; account.mode = s.mode; account.gender = s.gender; account.semester = s.semester;
  }

  closeSheet('editStudentSheet');
  showToast(`${s.name} updated`);
  // This action already knows the correct new state (we just mutated STUDENTS
  // directly) and isn't a fetch triggered by a navigate() hook, so refresh the
  // visible screen's HTML directly rather than going through navigate() again.
  refreshScreenContentOnly();
  return false;
}

function openEnrollSheet(){
  updateRegPreview();
  openSheet('enrollSheet');
}

function updateRegPreview(){
  const deptMap = {};
  PROGRAMMES.forEach(p => deptMap[p.key] = p.codePrefix);
  const dept = document.getElementById('enrollDept')?.value || PROGRAMMES[0].key;
  const mode = document.getElementById('enrollMode')?.value || 'DAY';
  const preview = document.getElementById('regNoPreview');
  if(preview) preview.textContent = `VU-${deptMap[dept]}-2601-${String(regNoCounter).padStart(4,'0')}-${mode}`;
}

function handleEnroll(e){
  e.preventDefault();
  const name = document.getElementById('enrollName').value.trim();
  const email = document.getElementById('enrollEmail').value.trim();
  const deptKey = document.getElementById('enrollDept').value;
  const year = document.getElementById('enrollYear').value;
  const mode = document.getElementById('enrollMode').value;
  const gender = document.getElementById('enrollGender').value;
  const semester = document.getElementById('enrollSemester').value;
  if(!name || !email || !deptKey){ return false; }

  const prog = PROGRAMMES.find(p => p.key === deptKey);
  const reg = `VU-${prog.codePrefix}-2601-${String(regNoCounter).padStart(4,'0')}-${mode}`;
  regNoCounter++;

  // Add to the visible Student Register immediately...
  STUDENTS.push({
    id: STUDENTS.length + 1, name, reg,
    facultyKey: prog.facultyKey, faculty: prog.facultyName,
    dept: prog.name, deptKey: prog.key, year,
    pct: null, trend: null,
    gender, semester,
    // Sept 2026 handoff, Part 1: mode/email were already collected by this
    // form and passed to createAccount()'s USERS record below, but were
    // never also written onto the STUDENTS record itself — meaning the
    // Register list/edit-sheet had no real field to read them back from.
    mode: mode === 'DAY' ? 'day' : 'evening',
    email,
  });

  // ...and provision a real login account behind it, with a one-time temp
  // password. This is the only place that password is ever shown.
  // Sept 2026 handoff, Part 3: Mode was already collected above (it's what
  // builds the -DAY/-EVE registration number suffix) but was never carried
  // any further as its own structured field — add it alongside gender/semester
  // so it's actually queryable (resolveCheckInOutcome()'s Day/Evening
  // mismatch check reads State.user.mode) rather than only ever implied by
  // parsing the registration number string.
  const tempPassword = createAccount({
    id: reg, name, role: 'student', email,
    extra: { reg, dept: prog.name, year, gender, semester, mode: mode === 'DAY' ? 'day' : 'evening', is_class_coordinator: false },
  });

  showTempPasswordConfirmation(name, reg, tempPassword);
  return false;
}

function showTempPasswordConfirmation(name, reg, tempPassword){
  // Swaps the CONTENT of the already-open enroll sheet in place, rather than
  // closing it and opening a second sheet. Closing+reopening a sheet on the
  // same tick fights with the back-button history bookkeeping (the pending
  // "close" pop and the new "open" push can land on the wrong entries) —
  // reusing one sheet avoids that entirely and is simpler besides.
  const title = document.getElementById('enrollSheetTitle');
  if(title) title.textContent = 'Account Created';
  const sheetBody = document.getElementById('enrollSheetBody');
  if(sheetBody){
    sheetBody.innerHTML = `
      <div class="empty-state" style="padding:6px 0 4px;">
        ${ICONS.checkCircle.replace(/width="\d+" height="\d+"/,'width="36" height="36"')}
        <div class="t" style="margin-top:12px;">${name} enrolled</div>
        <div class="s">${reg}</div>
      </div>
      <div class="info-box" style="margin-top:6px;">
        <div class="k">One-time temporary password</div>
        <div class="v" style="font-size:20px; letter-spacing:1px; font-family:monospace;">${tempPassword}</div>
      </div>
      <div style="font-size:11.5px; color:var(--ink-soft); line-height:1.5; margin-top:12px;">
        Share this with the student through a secure channel. It's shown only once and won't appear anywhere else —
        not in the Student Register, not in People search. They'll be asked to set their own password the first time they sign in.
      </div>
      <button class="btn btn-primary" style="margin-top:16px;" onclick="closeEnrollSheetAndReset()">Done</button>
    `;
  }
}

function closeEnrollSheetAndReset(){
  closeSheet('enrollSheet');
  // The actual content reset happens in resetSheetContentIfNeeded once the
  // close has settled, regardless of whether this was triggered by the Done
  // button or the back-button gesture (closeSheet routes through the same
  // popstate-adjacent cleanup either way).
}

// Sheets that show a one-time result (like the enroll confirmation) need to
// revert to their normal input form after closing, no matter how they were
// closed — Done button, overlay tap, or the hardware back button. Centralizing
// that here means every close path gets the same cleanup for free.
function resetSheetContentIfNeeded(sheetId){
  if(sheetId !== 'enrollSheet') return;
  setTimeout(()=>{
    const title = document.getElementById('enrollSheetTitle');
    if(title) title.textContent = 'Enroll New Student';
    const sheetBody = document.getElementById('enrollSheetBody');
    if(sheetBody) sheetBody.innerHTML = renderEnrollFormBody();
    const form = document.getElementById('enrollForm');
    if(form) form.reset();
  }, 250);
}

// ============================================================
// REGISTER: unified People screen (Sept 2026 handoff, Part 1)
// ------------------------------------------------------------
// Administrator  — everyone (students/lecturers/registrars/administrators),
//                  full enroll/edit/suspend/reactivate.
// Registrar      — students + lecturers only, scoped to their own faculty,
//                  can enroll students and create/edit Lecturer accounts
//                  (the create-account capability is new — Registrars could
//                  only enroll students before).
// Lecturer       — read-only list of students enrolled in their own courses.
//                  No enroll/edit/create-account UI at all (a prior build had
//                  this rendering unconditionally via renderStudents() for
//                  every role that could reach the screen, including
//                  Lecturer — that was a real bug, fixed by giving Lecturer
//                  its own capability checks below rather than assuming the
//                  screen was already read-only for them).
//
// The mock data has no per-student course-enrollment table, so "a Lecturer's
// own students" is approximated the same way LECTURER_COURSES/scopedLecturer-
// Compliance already approximate lecturer/course relationships elsewhere in
// this file: courses this lecturer is assigned to (COURSES.lecturer === their
// name) -> those courses' programmes -> students in those programmes. This is
// a judgment call, not a real enrollment join — flagged in the handoff summary.
// ============================================================

function coursesForLecturer(){
  const name = State.user && State.user.name;
  if(!name) return [];
  return COURSES.filter(c => c.lecturer === name);
}

function studentsForLecturer(){
  const progKeys = new Set(coursesForLecturer().map(c => c.programmeKey).filter(Boolean));
  if(!progKeys.size) return [];
  return STUDENTS.filter(s => progKeys.has(s.deptKey));
}

// Whether the current user can edit/suspend/reactivate this specific person.
// Administrator manages everyone; Registrar manages students+lecturers only
// (never fellow registrars or administrators); Lecturer never manages anyone.
function canManagePerson(p){
  if(State.role === 'administrator') return true;
  if(State.role === 'registrar') return p.role === 'student' || p.role === 'lecturer';
  return false;
}

// Register's "provisioned" status previously only checked the mock USERS
// object (the hardcoded demo/test login credentials) — meaning any account
// created directly in Supabase (like Balinda's, set up mid-session) always
// showed "Not provisioned" even though it genuinely works. This fetches the
// real list of university_ids that have a live account, so that check
// reflects reality instead of just the mock roster.
let LIVE_PROVISIONED_IDS = new Set();

async function loadProvisionedAccountsFromSupabase(){
  if(!LIVE_BACKEND) return;
  try {
    const { data: rows, error } = await SUPABASE_CLIENT
      .from('users')
      .select('university_id');
    if(error){ console.warn('loadProvisionedAccountsFromSupabase failed:', error); return; }
    if(!rows) return;
    LIVE_PROVISIONED_IDS = new Set(rows.map(r => r.university_id).filter(Boolean));
    refreshScreenContentOnly(); // hook-free — see its own comment for why not rerenderCurrentScreen()
  } catch(e){
    console.warn('loadProvisionedAccountsFromSupabase error:', e);
  }
}

// Shared by both tagging functions below so they can't drift on what
// "provisioned" means — checks the mock USERS object (demo/test accounts)
// OR the live Supabase account list, either one counts as a real account.
function isProvisionedAccount(id){
  return !!USERS[id] || LIVE_PROVISIONED_IDS.has(id);
}

function tagStudentForRegister(s){
  const account = USERS[s.reg];
  const provisioned = isProvisionedAccount(s.reg);
  return {
    id: s.reg, role: 'student', name: s.name,
    dept: s.dept, deptKey: s.deptKey, facultyKey: s.facultyKey, faculty: s.faculty,
    year: s.year, gender: s.gender, semester: s.semester, mode: s.mode,
    email: s.email || vuEmail(s.name),
    pct: s.pct, trend: s.trend,
    status: account ? (account.status || 'active') : (provisioned ? 'active' : 'unprovisioned'),
    hasAccount: provisioned,
    _studentId: s.id,
  };
}

function tagStaffForRegister(p, role){
  const account = USERS[p.id];
  const provisioned = isProvisionedAccount(p.id);
  return {
    id: p.id, role, name: p.name,
    dept: p.dept, facultyKey: p.facultyKey || facultyKeyForProgrammeName(p.dept),
    email: p.email,
    status: account ? (account.status || 'active') : (provisioned ? 'active' : (p.status || 'active')),
    hasAccount: provisioned,
  };
}

// The role-scoped, tagged people list Register actually renders. This is the
// one chokepoint where the DATA scoping for Part 1 happens — screen
// reachability itself is still handled structurally by NAV_CONFIG/
// getScreenHTML, per this codebase's existing access-control convention.
function scopedRegisterPeople(){
  if(State.role === 'lecturer'){
    return studentsForLecturer().map(tagStudentForRegister);
  }
  const students = scopedStudents().map(tagStudentForRegister);
  const lecturers = LECTURERS.map(l => tagStaffForRegister(l, 'lecturer'));
  if(State.role === 'registrar'){
    const fk = currentRegistrarFacultyKey();
    const scopedLecturers = fk ? lecturers.filter(l => l.facultyKey === fk) : lecturers;
    return [...students, ...scopedLecturers];
  }
  // Administrator: everyone.
  const registrars = REGISTRARS.map(r => tagStaffForRegister(r, 'registrar'));
  const administrators = ADMINISTRATORS.map(a => tagStaffForRegister(a, 'administrator'));
  return [...administrators, ...registrars, ...lecturers, ...students];
}

function renderRegister(opts){
  opts = opts || {};
  const backTarget = opts.backTarget || 'dashboard';
  const isAdmin = State.role === 'administrator';
  const isRegistrar = State.role === 'registrar';
  const isLecturer = State.role === 'lecturer';
  const canManage = isAdmin || isRegistrar; // both enroll/create AND edit/suspend gate together
  const fk = currentRegistrarFacultyKey();
  const people = scopedRegisterPeople();

  const title = isLecturer ? 'My Students' : 'Register';

  const facultyChipsHtml = !isLecturer ? `
    <div class="dept-chip-row">
      ${(isRegistrar ? FACULTY_COUNTS.filter(d=>d.key===fk) : FACULTY_COUNTS).map(d=>`
      <div class="dept-chip ${palClass(d.key, FACULTIES.map(f=>f.key))}">
        <div class="n">${d.count}</div>
        <div class="l">${d.label.replace('Faculty of ','')}</div>
      </div>`).join('')}
    </div>` : '';

  const roleFilterHtml = !isLecturer ? `
    <div class="field">
      <select class="select" id="registerRoleFilter" onchange="filterRegister()">
        <option value="">All People</option>
        <option value="student">Students</option>
        <option value="lecturer">Lecturers</option>
        ${isAdmin ? `<option value="registrar">Registrars</option><option value="administrator">Administrators</option>` : ''}
      </select>
    </div>` : '';

  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('${backTarget}')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">${title}</div>
    </div>
  </div>
  <div class="content" style="padding-bottom:${canManage ? '90px' : '24px'};">
    ${isLecturer ? `<div style="font-size:12px;color:var(--ink-soft);margin:-4px 0 14px;">Students enrolled in your courses — read only</div>` : ''}
    ${facultyChipsHtml}
    <div class="search-wrap">
      ${ICONS.search}
      <input class="input" placeholder="Search by name or ID..." oninput="filterRegister()" id="registerSearch" />
    </div>
    <div class="field-row">
      ${roleFilterHtml}
      ${!isLecturer ? `
      <div class="field">
        <select class="select" id="registerYearFilter" onchange="filterRegister()">
          <option value="">All Years</option>
          <option value="Year 1">Year 1</option>
          <option value="Year 2">Year 2</option>
          <option value="Year 3">Year 3</option>
        </select>
      </div>` : ''}
    </div>

    <div class="card card-pad">
      <div class="section-head-row">
        <div class="section-title" style="margin-bottom:0;">${ICONS.users} ${isLecturer ? 'My Students' : 'People'}</div>
        <span style="font-size:11px;color:var(--ink-faint);font-weight:600;">${people.length} ${isLecturer ? 'enrolled' : 'total'}</span>
      </div>
      <div id="registerList" style="max-height:60vh; overflow-y:auto; -webkit-overflow-scrolling:touch;">
        ${people.length ? people.map(p=>registerPersonRow(p)).join('') : `
        <div class="empty-state" style="padding:24px 10px;">
          ${ICONS.users}
          <div class="t">No one to show yet</div>
          <div class="s">${isLecturer ? "You'll see students here once you're assigned a course" : 'Try adjusting filters'}</div>
        </div>`}
      </div>
    </div>
  </div>
  ${canManage ? `
  <div class="sticky-footer">
    <div class="sticky-footer-inner" style="padding:8px; display:flex; gap:8px;">
      <button class="btn btn-primary" style="flex:1;" onclick="openEnrollSheet()">${ICONS.plus} Enroll Student</button>
      <button class="btn btn-ghost" style="flex:1;" onclick="openCreateAccountSheet()">${ICONS.plus} Create Account</button>
    </div>
  </div>

  <div class="sheet" id="enrollSheet">
    <div class="sheet-handle"></div>
    <div class="sheet-title">
      <span id="enrollSheetTitle">Enroll New Student</span>
      <button onclick="closeSheet('enrollSheet')">${ICONS.close}</button>
    </div>
    <div id="enrollSheetBody">${renderEnrollFormBody()}</div>
  </div>

  <div class="sheet" id="createAccountSheet">
    <div class="sheet-handle"></div>
    <div class="sheet-title">
      <span id="createAccountTitle">Create Account</span>
      <button onclick="closeSheet('createAccountSheet')">${ICONS.close}</button>
    </div>
    <div id="createAccountBody">${renderCreateAccountFormBody()}</div>
  </div>

  <div class="sheet" id="editStudentSheet">
    <div class="sheet-handle"></div>
    <div class="sheet-title">
      <span>Edit Student</span>
      <button onclick="closeSheet('editStudentSheet')">${ICONS.close}</button>
    </div>
    <div id="editStudentBody"></div>
  </div>

  <div class="sheet" id="editStaffSheet">
    <div class="sheet-handle"></div>
    <div class="sheet-title">
      <span id="editStaffSheetTitle">Edit Profile</span>
      <button onclick="closeSheet('editStaffSheet')">${ICONS.close}</button>
    </div>
    <div id="editStaffBody"></div>
  </div>

  <div class="sheet" id="accountDetailSheet">
    <div class="sheet-handle"></div>
    <div class="sheet-title">
      <span id="accountDetailTitle">Account</span>
      <button onclick="closeSheet('accountDetailSheet')">${ICONS.close}</button>
    </div>
    <div id="accountDetailBody"></div>
  </div>` : ''}`;
}

function registerPersonRow(p){
  const meta = ROLE_BADGE_META[p.role] || { label:p.role, color:"#475569", bg:"#f1f5f9" };
  const manage = canManagePerson(p);
  const statusBadge = p.status === 'suspended'
    ? `<span class="badge dept" style="background:#fee2e2;color:#b91c1c;">Suspended</span>`
    : p.status === 'unprovisioned'
    ? `<span class="badge dept" style="background:#f1f5f9;color:#64748b;">Not provisioned</span>`
    : '';
  const metaLine = p.role === 'student'
    ? `${p.id} · ${p.year || '—'} · ${p.gender || '—'} · ${p.semester || '—'}${p.mode ? ' · ' + (p.mode==='day'?'Day':'Evening') : ''}`
    : `${p.id}${p.dept ? ' · ' + p.dept : ''}`;
  const pctBlock = (p.role === 'student')
    ? (p.pct !== null && p.pct !== undefined
        ? `<div class="attendance-pct ${p.pct >= ATTENDANCE_POLICIES.minAttendancePct ? 'good':'bad'}">${p.trend==='up'?'↑':'↓'} ${p.pct}%<span class="lbl">attendance</span></div>`
        : `<div class="attendance-pct" style="color:var(--ink-faint);font-weight:600;font-size:11px;">no records</div>`)
    : '';
  const editBtn = manage
    ? `<button class="icon-btn" style="width:32px;height:32px;flex-shrink:0;background:var(--surface);border:1.5px solid var(--line);color:var(--theme-primary);border-radius:var(--radius-sm);" title="Edit profile" onclick="event.stopPropagation();${p.role==='student' ? `openEditStudentSheet('${p._studentId}')` : `openEditStaffSheet('${p.id}','${p.role}')`}">${ICONS.edit || ICONS.settings}</button>`
    : '';
  return `
  <div class="student-card-row" data-register-row data-name="${p.name.toLowerCase()}" data-id="${p.id.toLowerCase()}" data-role="${p.role}" data-year="${p.year||''}" ${manage ? `onclick="openAccountDetail('${p.id}')" style="cursor:pointer;"` : ''}>
    <div class="avatar">${initials(p.name)}</div>
    <div class="student-info">
      <div class="student-name">${p.name}</div>
      <div class="student-meta">${metaLine}</div>
      <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap;">
        <span class="badge dept" style="background:${meta.bg};color:${meta.color};">${meta.label}</span>
        ${statusBadge}
      </div>
    </div>
    ${pctBlock}
    ${editBtn}
  </div>`;
}

function filterRegister(){
  const q = (document.getElementById('registerSearch')?.value || '').toLowerCase();
  const role = document.getElementById('registerRoleFilter')?.value || '';
  const year = document.getElementById('registerYearFilter')?.value || '';
  let visibleCount = 0;
  document.querySelectorAll('[data-register-row]').forEach(row=>{
    const textMatch = !q || row.dataset.name.includes(q) || row.dataset.id.includes(q);
    const roleMatch = !role || row.dataset.role === role;
    const yearMatch = !year || row.dataset.year === year;
    const visible = textMatch && roleMatch && yearMatch;
    row.style.display = visible ? 'flex' : 'none';
    if(visible) visibleCount++;
  });
  toggleNoResultsState('registerList', visibleCount, 'Try adjusting your search or filters');
}

// Edit sheet for Lecturer/Registrar/Administrator profiles — the staff-side
// counterpart to openEditStudentSheet/renderEditStudentFormBody above.
// "Assigned Courses" (Lecturer only) is a checkbox reconciliation against
// COURSES.lecturer, since the mock catalog stores one lecturer name per
// course rather than a real lecturer<->course join table.
function openEditStaffSheet(personId, role){
  let p;
  if(role === 'lecturer') p = LECTURERS.find(x => x.id === personId);
  else if(role === 'registrar') p = REGISTRARS.find(x => x.id === personId);
  else if(role === 'administrator') p = ADMINISTRATORS.find(x => x.id === personId);
  if(!p){ showToast('Person not found'); return; }
  const title = document.getElementById('editStaffSheetTitle');
  if(title) title.textContent = `Edit ${ROLE_BADGE_META[role]?.label || 'Profile'}`;
  const body = document.getElementById('editStaffBody');
  if(body) body.innerHTML = renderEditStaffFormBody(p, role);
  openSheet('editStaffSheet');
}

function renderEditStaffFormBody(p, role){
  return `
    <div style="font-size:12px;color:var(--ink-soft);margin:-8px 0 16px;">${p.id}</div>
    <form id="editStaffForm" onsubmit="return submitEditStaff(event, '${p.id}', '${role}')" style="display:flex;flex-direction:column;gap:14px;">
      <div class="field">
        <label>Full Name <span class="req">*</span></label>
        <input class="input" id="editStaffName" value="${p.name}" required />
      </div>
      <div class="field">
        <label>Email Address</label>
        <input class="input" type="email" id="editStaffEmail" value="${p.email || ''}" />
      </div>
      <div class="field">
        <label>Department${role==='registrar' ? ' / Faculty' : ''}</label>
        <input class="input" id="editStaffDept" value="${p.dept || ''}" placeholder="e.g. Computer Science" />
      </div>
      ${role === 'lecturer' ? `
      <div class="field">
        <label>Assigned Courses</label>
        <div style="display:flex;flex-direction:column;gap:8px;max-height:180px;overflow-y:auto;border:1.5px solid var(--line);border-radius:var(--radius-sm);padding:10px;">
          ${COURSES.length ? COURSES.map(c => `
          <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;">
            <input type="checkbox" class="editStaffCourseChk" value="${c.code}" ${c.lecturer===p.name?'checked':''} />
            ${c.code} — ${c.name}
          </label>`).join('') : `<span style="font-size:12px;color:var(--ink-faint);">No courses in the catalog yet</span>`}
        </div>
      </div>` : ''}
      <div class="btn-row" style="margin-top:6px;">
        <button type="button" class="btn btn-ghost" onclick="closeSheet('editStaffSheet')">Cancel</button>
        <button type="submit" class="btn btn-primary">${ICONS.check} Save</button>
      </div>
    </form>`;
}

function submitEditStaff(e, personId, role){
  e.preventDefault();
  let directoryArray;
  if(role === 'lecturer') directoryArray = LECTURERS;
  else if(role === 'registrar') directoryArray = REGISTRARS;
  else if(role === 'administrator') directoryArray = ADMINISTRATORS;
  const entry = directoryArray && directoryArray.find(x => x.id === personId);
  if(!entry) return false;

  const name = document.getElementById('editStaffName')?.value.trim();
  if(!name){ showToast('Enter a full name'); return false; }
  const email = document.getElementById('editStaffEmail')?.value.trim();
  const dept = document.getElementById('editStaffDept')?.value.trim();
  const oldName = entry.name;

  if(role === 'lecturer'){
    // Reconcile the checkbox state against COURSES.lecturer using the OLD
    // name (before we rename entry.name below) so a course this lecturer
    // used to teach but just got unchecked is correctly released, and one
    // newly checked (whether previously unassigned or reassigned from
    // someone else) is correctly claimed under the new name.
    const checked = new Set(Array.from(document.querySelectorAll('.editStaffCourseChk:checked')).map(el => el.value));
    COURSES.forEach(c => {
      const wasAssignedToThisLecturer = c.lecturer === oldName;
      if(checked.has(c.code)) c.lecturer = name;
      else if(wasAssignedToThisLecturer) c.lecturer = null;
    });
  }

  entry.name = name;
  entry.email = email || vuEmail(name);
  entry.dept = dept || null;
  const account = USERS[personId];
  if(account){ account.name = name; account.email = entry.email; account.dept = entry.dept; }

  closeSheet('editStaffSheet');
  showToast(`${name} updated`);
  refreshScreenContentOnly();
  return false;
}

// ============================================================
// STUDENT: HOME
// ============================================================

// Sept 2026 handoff (Register/Timetable/Records), Part 2: a lecture slot's
// `mode` is 'day' | 'evening' | null. null means "no restriction" (every
// pre-existing slot, plus any new/edited one left unset) and is always
// visible; a student only sees a mode-restricted slot that matches their
// own State.user.mode. Centralized here so Home, the Timetable screen and
// the countdown/late-warning banner (which reads getStudentTodayLectures()
// internally) can never drift on this rule.
function filterLecturesForStudentMode(lectures){
  const mode = State.user && State.user.mode;
  if(!mode) return lectures; // no mode on file for this account — don't over-filter
  return lectures.filter(l => !l.mode || l.mode === mode);
}

function getStudentTodayLectures(){
  const today = SCHEDULE.find(d=>d.isToday);
  if(!today) return [];
  const myCourseCodes = STUDENT_COURSES.map(c=>c.code);
  const enrolled = today.lectures.filter(l=>myCourseCodes.includes(l.code));
  return filterLecturesForStudentMode(enrolled);
}

// Sept 2026 handoff, Part 2: which (if any) of the student's own today
// lectures should drive the Home banner's countdown/late-warning states.
// Only called when no live broadcast is already open for this student (see
// renderStudentHome() — the existing "session is live"/"you're checked in"
// banner always takes priority when there is one). Evaluated fresh on every
// call rather than cached, since "now" and hasCheckedInToday both change
// while a student is sitting on this screen.
//   'late'      — this lecture's scheduled window has started (and not yet
//                 ended) and the student hasn't checked in. Independent of
//                 whether the Lecturer has actually started broadcasting —
//                 a Lecturer could be marked DL/LOT and start late.
//   'countdown' — this lecture starts within the next 10 minutes.
// Lectures are checked in their SCHEDULE order and the first match wins, so
// a lecture already in its "late" window is preferred over a later one
// that's merely approaching — the two states can't both apply to the same
// moment for a single lecture anyway, since they're based on the same clock.
function getStudentBannerLecture(now){
  now = now || new Date();
  for(const l of getStudentTodayLectures()){
    const range = parseLectureTimeRange(l.time, now);
    if(!range) continue;
    if(now >= range.start && now <= range.end) return { lecture:l, kind:'late', range };
    if(range.start > now && (range.start - now) <= 10*60*1000) return { lecture:l, kind:'countdown', range };
  }
  return null;
}

// One label for whichever of the Home banner's five mutually-exclusive
// variants should currently be showing — used only to detect when the
// ticker below needs to force a full re-render vs. just tick the countdown
// text (see startStudentBannerTicker()).
function computeStudentBannerMode(){
  if(isLiveSessionOpenForStudent()) return State.hasCheckedInToday ? 'checkedIn' : 'live';
  const info = getStudentBannerLecture();
  return info ? info.kind : 'none';
}

let studentBannerInterval = null;
let _lastStudentBannerMode = null;

// Sept 2026 handoff, Part 2: its own interval, deliberately not sharing
// sessionTickInterval or rosterPollInterval (those are Lecturer-side and
// have stop conditions of their own that don't apply here). Comparing
// against "now" here uses this device's own clock — unlike Part 1's
// Lecturer-side compliance timing, a few seconds of drift on a countdown
// display doesn't matter the way it matters for a compliance record, so
// this deliberately doesn't do a server round-trip it doesn't need.
function startStudentBannerTicker(){
  stopStudentBannerTicker();
  _lastStudentBannerMode = computeStudentBannerMode();
  studentBannerInterval = setInterval(()=>{
    if(currentScreen !== 'home'){ stopStudentBannerTicker(); return; }
    const mode = computeStudentBannerMode();
    if(mode !== _lastStudentBannerMode){
      // The banner variant itself changed (countdown elapsed into "late",
      // a session went live, the student checked in, etc.) — this needs
      // genuinely different markup, not just a text update, and this tick
      // was itself triggered by a background timer rather than one of
      // navigate()'s own hooks, so refreshScreenContentOnly() (not
      // navigate()/rerenderCurrentScreen()) is the safe way to redraw it.
      _lastStudentBannerMode = mode;
      refreshScreenContentOnly();
      return;
    }
    if(mode === 'countdown'){
      const countdownEl = document.getElementById('studentBannerCountdown');
      const info = getStudentBannerLecture();
      if(countdownEl && info){
        const remainingSec = Math.max(0, Math.floor((info.range.start - new Date())/1000));
        countdownEl.textContent = `${Math.floor(remainingSec/60)}:${String(remainingSec%60).padStart(2,'0')}`;
      }
    }
  }, 1000);
}

function stopStudentBannerTicker(){
  if(studentBannerInterval){
    clearInterval(studentBannerInterval);
    studentBannerInterval = null;
  }
}

function renderStudentHome(){
  const u = State.user;
  const todayLectures = getStudentTodayLectures();
  const sessionOpenForMe = isLiveSessionOpenForStudent();
  const bannerLecture = sessionOpenForMe ? null : getStudentBannerLecture();

  return `
  <div class="app-header">
    <div class="brand-row">
      <div class="brand-id">
        <div class="brand-mark">${VU_LOGO_MARK}</div>
        <div class="brand-text">
          <div class="name">VUSAP</div>
          <div class="sub">Student Portal</div>
        </div>
      </div>
      <div class="header-actions">
        <button class="icon-btn notif-bell-btn" onclick="navigate('notifications')" style="position:relative;">${ICONS.bell}${unreadNotifCount()>0 ? `<span class='notif-badge'>${unreadNotifCount()}</span>` : ''}</button>
        <button class="avatar-chip" onclick="navigate('profile')" title="Profile">${initials(u.name)}</button>
      </div>
    </div>
  </div>
  <div class="content">
    <div class="profile-card">
      <div class="profile-avatar-lg">${initials(u.name)}</div>
      <div class="profile-name">${u.name}</div>
      <div class="profile-reg">${u.reg}</div>
      <div class="profile-meta-row">
        <span class="tag-pill">${u.dept}</span>
        <span class="tag-pill">${u.year || '—'}</span>
      </div>
      ${u.is_class_coordinator ? `<div class="coordinator-badge" style="margin-top:10px;">${ICONS.shield.replace(/<svg /,'<svg style="width:12px;height:12px;" ')} Class Coordinator</div>` : ''}
    </div>

    ${sessionOpenForMe ? (State.hasCheckedInToday ? `
    <button class="checkin-cta" onclick="navigate('checkin')" style="background:linear-gradient(135deg, var(--present), #0d8a3e);">
      <div class="ci-icon">${ICONS.checkCircle.replace(/width="\d+" height="\d+"/,'width="26" height="26"')}</div>
      <div class="ci-title">You're checked in</div>
      <div class="ci-sub">${LIVE_SESSION.courseName} · marked Present</div>
    </button>` : `
    <button class="checkin-cta" onclick="navigate('checkin')">
      <div class="ci-icon">${ICONS.qrcode}</div>
      <div class="ci-title"><span class="live-pulse"></span>${LIVE_SESSION.courseName} session is live</div>
      <div class="ci-sub">Tap to check in now · ${LIVE_SESSION.room}</div>
    </button>`) : (bannerLecture && bannerLecture.kind === 'late' ? `
    <div class="card card-pad" style="text-align:center; border-color:#fecaca;">
      <div class="empty-state" style="padding:18px 10px;">
        ${ICONS.alertTriangle}
        <div class="t" style="color:var(--absent);">You are late, hurry up and check in</div>
        <div class="s">${bannerLecture.lecture.code} — ${bannerLecture.lecture.name} · ${bannerLecture.lecture.room}</div>
      </div>
    </div>` : bannerLecture && bannerLecture.kind === 'countdown' ? `
    <div class="card card-pad" style="text-align:center;">
      <div class="empty-state" style="padding:18px 10px;">
        ${ICONS.clock}
        <div class="t">${bannerLecture.lecture.code} starts soon</div>
        <div class="s">Starts in <span id="studentBannerCountdown" style="font-weight:700;">--:--</span> · ${bannerLecture.lecture.room}</div>
      </div>
    </div>` : `
    <div class="card card-pad" style="text-align:center;">
      <div class="empty-state" style="padding:18px 10px;">
        ${ICONS.inbox}
        <div class="t">No active session right now</div>
        <div class="s">Check-in opens when your lecturer starts a session</div>
      </div>
    </div>`)}

    <div class="stat-grid">
      <div class="stat-tile">
        <div class="top"><span class="label">Attendance Rate</span>
          <span class="stat-icon" style="background:#ccfbf1; color:#0f766e;">${ICONS.trend}</span></div>
        <div class="value">${STUDENT_ATTENDANCE_SUMMARY.rate}%</div>
      </div>
      <div class="stat-tile">
        <div class="top"><span class="label">Courses Enrolled</span>
          <span class="stat-icon" style="background:#dbeafe; color:#1d4ed8;">${ICONS.book}</span></div>
        <div class="value">${STUDENT_COURSES.length}</div>
      </div>
    </div>

    <div class="card section-card">
      <div class="section-head-row">
        <div class="section-title" style="margin-bottom:0;">${ICONS.clock} Today's Classes</div>
      </div>
      ${todayLectures.length ? todayLectures.map(l=>`
        <div class="lecture-row" style="margin-bottom:8px;">
          <div>
            <div class="lecture-code">${l.code}</div>
            <div class="lecture-name">${l.name}</div>
            <div class="lecture-meta">${ICONS.clock}${l.time} · ${l.room}</div>
          </div>
          ${l.code===LIVE_SESSION.courseCode && l.mode===LIVE_SESSION.mode && isLiveSessionActive() ? '<span class="badge today">Live</span>' : ''}
        </div>`).join('') : `<div class="empty-state" style="padding:14px;"><div class="t" style="font-size:12.5px;">No classes scheduled today</div></div>`}
    </div>

    <div class="card section-card">
      <div class="section-title">${ICONS.book} My Courses</div>
      ${STUDENT_COURSES.map(c=>`
        <div class="course-pill-row">
          <span class="course-dot" style="background:${c.color};"></span>
          <div class="ctext">
            <div class="ccode">${c.code} — ${c.name}</div>
            <div class="cname">${c.lecturer}</div>
          </div>
        </div>`).join('')}
    </div>

    ${u.is_class_coordinator ? `
    <div class="card section-card coordinator-section">
      <div class="section-title">${ICONS.shield.replace(/<svg /,'<svg style="color:var(--coord-flag);" ')} Class Coordinator Tools</div>
      <div style="font-size:11.5px; color:var(--ink-soft); margin-bottom:12px;">For ${u.coordinator_for_programme} · ${u.coordinator_for_year}</div>
      <div style="display:flex; flex-direction:column; gap:10px;">
        <a class="quick-action" style="background:var(--surface);" onclick="navigate('classSummary')">
          <div class="qa-icon" style="background:var(--coord-flag);">${ICONS.chart}</div>
          <div class="qa-text"><div class="t">Class Attendance Summary</div><div class="s">Trends for your assigned class</div></div>
          <div class="chev">${ICONS.chevR}</div>
        </a>
        <a class="quick-action" style="background:var(--surface);" onclick="navigate('missingStudents')">
          <div class="qa-icon" style="background:var(--coord-flag);">${ICONS.alertTriangle}</div>
          <div class="qa-text"><div class="t">Missing Student List</div><div class="s">Who hasn't checked in today</div></div>
          <div class="chev">${ICONS.chevR}</div>
        </a>
        <a class="quick-action" style="background:var(--surface);" onclick="navigate('classReport')">
          <div class="qa-icon" style="background:var(--coord-flag);">${ICONS.fileText}</div>
          <div class="qa-text"><div class="t">Submit Class Report</div><div class="s">Report lecturer absence or issues</div></div>
          <div class="chev">${ICONS.chevR}</div>
        </a>
      </div>
    </div>` : ''}

    <a class="quick-action" onclick="navigate('announcements')">
      <div class="qa-icon">${ICONS.megaphone}</div>
      <div class="qa-text"><div class="t">Announcements</div><div class="s">${ANNOUNCEMENTS.length} recent updates</div></div>
      <div class="chev">${ICONS.chevR}</div>
    </a>
    <a class="quick-action" onclick="navigate('appeals')">
      <div class="qa-icon">${ICONS.gavel}</div>
      <div class="qa-text"><div class="t">Attendance Appeals</div><div class="s">Submit or track an appeal</div></div>
      <div class="chev">${ICONS.chevR}</div>
    </a>
    <a class="quick-action" onclick="navigate('timetable')">
      <div class="qa-icon">${ICONS.calendar}</div>
      <div class="qa-text"><div class="t">My Timetable</div><div class="s">View your full weekly schedule</div></div>
      <div class="chev">${ICONS.chevR}</div>
    </a>
    <a class="quick-action" onclick="navigate('profile')">
      <div class="qa-icon">${ICONS.user}</div>
      <div class="qa-text"><div class="t">Profile & Settings</div><div class="s">View ID, contact info, preferences</div></div>
      <div class="chev">${ICONS.chevR}</div>
    </a>
  </div>`;
}

// ============================================================
// STUDENT: TIMETABLE (reuses schedule rendering, filtered to enrolled courses)
// ============================================================

function renderStudentTimetable(){
  const myCourseCodes = STUDENT_COURSES.map(c=>c.code);
  const filteredSchedule = SCHEDULE.map(d=>({
    ...d,
    lectures: filterLecturesForStudentMode(d.lectures.filter(l=>myCourseCodes.includes(l.code)))
  })).filter(d=>d.lectures.length>0);

  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('home')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">My Timetable</div>
    </div>
  </div>
  <div class="content">
    ${filteredSchedule.map(d=>scheduleDayGroup(d, false)).join('')}
  </div>`;
}

// ============================================================
// STUDENT: PROFILE & SETTINGS
// ============================================================

function renderStudentProfile(){
  const u = State.user;
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('home')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Profile & Settings</div>
    </div>
  </div>
  <div class="content">
    <div class="profile-card">
      <div class="profile-avatar-lg">${initials(u.name)}</div>
      <div class="profile-name">${u.name}</div>
      <div class="profile-reg">${u.reg}</div>
    </div>

    <div class="card card-pad">
      <div class="section-title">${ICONS.graduation} Academic Information</div>
      <div class="info-list">
        <div class="info-list-row"><span class="k">${ICONS.user} Full Name</span><span class="v">${u.name}</span></div>
        <div class="info-list-row"><span class="k">${ICONS.pin} Registration No.</span><span class="v">${u.reg}</span></div>
        <div class="info-list-row"><span class="k">${ICONS.book} Programme</span><span class="v">${u.dept}</span></div>
        <div class="info-list-row"><span class="k">${ICONS.calendar} Year of Study</span><span class="v">${u.year || '—'}</span></div>
        <div class="info-list-row"><span class="k">${ICONS.mail} Email</span><span class="v" style="font-size:11.5px;">${vuEmail(u.name)}</span></div>
      </div>
    </div>

    <div class="card card-pad">
      <div class="section-title">${ICONS.settings} Preferences</div>
      <div class="info-list-row">
        <span class="k">${ICONS.moon} Dark Mode</span>
        <div class="toggle-wrap">
          <input type="checkbox" id="darkModeToggle" ${(document.documentElement.getAttribute('data-theme') || 'light') === 'dark' ? 'checked' : ''} onchange="toggleDarkMode()">
          <div class="toggle-slider"></div>
        </div>
      </div>
    </div>

    <button class="btn btn-ghost" onclick="logout()" style="color:var(--absent); border-color:#fecaca;">${ICONS.logout} Sign Out</button>
  </div>`;
}

// ============================================================
// STUDENT: CHECK-IN (QR scan + PIN entry)
// ============================================================

let checkinMethod = 'qr';

function renderCheckIn(){
  const sessionOpen = isLiveSessionOpenForStudent();
  if(!sessionOpen){
    return `
    <div class="app-header">
      <div class="header-back">
        <button class="back-btn" onclick="navigate('home')">${ICONS.back}</button>
        <div class="page-title" style="font-size:18px;">Check In</div>
      </div>
    </div>
    <div class="content">
      <div class="error-state">
        <div class="err-icon">${ICONS.alertTriangle}</div>
        <div class="t">No active session</div>
        <div class="s">There's no live check-in session for your courses right now.</div>
        <button class="btn btn-primary" onclick="navigate('home')" style="max-width:200px;margin:0 auto;">Back to Home</button>
      </div>
    </div>`;
  }

  if(State.hasCheckedInToday){
    return `
    <div class="app-header">
      <div class="header-back">
        <button class="back-btn" onclick="navigate('home')">${ICONS.back}</button>
        <div class="page-title" style="font-size:18px;">Check In</div>
      </div>
    </div>
    <div class="content">
      <div class="empty-state" style="padding:50px 20px;">
        ${ICONS.checkCircle}
        <div class="t" style="margin-top:14px;">You're checked in</div>
        <div class="s">${LIVE_SESSION.courseName} · marked Present</div>
      </div>
    </div>`;
  }

  // Sept 2026 handoff, Part 2: brief interstitial while resolveCheckInOutcome()
  // is awaited in completeCheckIn() — only ever visible on a live-backend
  // account (mock mode resolves synchronously, so this never renders there).
  if(State.checkInVerifying){
    return `
    <div class="app-header">
      <div class="header-back">
        <button class="back-btn" onclick="navigate('home')">${ICONS.back}</button>
        <div class="page-title" style="font-size:18px;">Check In</div>
      </div>
    </div>
    <div class="content">
      <div class="empty-state" style="padding:50px 20px;">
        <div class="t">Verifying check-in…</div>
        <div class="s">Just a moment</div>
      </div>
    </div>`;
  }

  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('home')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Check In</div>
    </div>
  </div>
  <div class="content">
    <div class="info-box" style="text-align:center;">
      <div class="k">${LIVE_SESSION.courseCode} — ${LIVE_SESSION.courseName}</div>
      <div class="v" style="font-size:13px;">${LIVE_SESSION.room}</div>
    </div>

    <div class="method-tabs">
      <button class="method-tab ${checkinMethod==='qr'?'active':''}" onclick="setCheckinMethod('qr')">${ICONS.qrcode} Scan QR</button>
      <button class="method-tab ${checkinMethod==='pin'?'active':''}" onclick="setCheckinMethod('pin')">${ICONS.keypad} Enter PIN</button>
    </div>

    <div id="checkinMethodArea">
      ${checkinMethod === 'qr' ? renderQrScanArea() : renderPinEntryArea()}
    </div>

    <div class="card card-pad" style="background:#f0fdfa; border-color:#ccfbf1;">
      <div class="section-title" style="margin-bottom:8px; color:#0f766e;">${ICONS.shield} Anti-fraud protection</div>
      <div style="font-size:11.5px; color:var(--ink-soft); line-height:1.5;">Each check-in is tied to this device and a one-time session code. Checking in for someone else, or from a shared/duplicate device, will be flagged for review.</div>
    </div>
  </div>`;
}

function setCheckinMethod(m){
  if(checkinMethod === 'qr' && m !== 'qr') stopQrScanner();
  checkinMethod = m;
  State.pinEntry = "";
  rerenderCurrentScreen();
}

function renderQrScanArea(){
  return `
  <div class="card card-pad" style="background:#0b1320;">
    <div class="scan-frame-wrap" id="scanFrameWrap">
      <video id="qrVideo" autoplay playsinline muted style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:none;"></video>
      <div class="scan-frame-corner tl"></div>
      <div class="scan-frame-corner tr"></div>
      <div class="scan-frame-corner bl"></div>
      <div class="scan-frame-corner br"></div>
      <div class="scan-laser" id="scanLaser"></div>
      <div id="scanIdleIcon" style="color:rgba(255,255,255,0.4); position:relative; z-index:1;">${ICONS.camera.replace(/width="\d+" height="\d+"/,'width="42" height="42"')}</div>
    </div>
    <div class="scan-hint" id="scanHint" style="margin-top:14px;">Starting camera…</div>
  </div>
  <canvas id="qrScanCanvas" style="display:none;"></canvas>
  <div id="scanFallbackArea"></div>`;
}

// ---------- REAL CAMERA QR SCANNING (getUserMedia + jsQR) ----------
let qrScanStream = null;
let qrScanRafId = null;
let qrScanLastResult = null; // debounce: avoid firing completeCheckIn multiple times per scan

async function startQrScanner(){
  if(qrScanStream) return; // already running — avoid requesting the camera twice
  const video = document.getElementById('qrVideo');
  const hint = document.getElementById('scanHint');
  const idleIcon = document.getElementById('scanIdleIcon');
  const fallback = document.getElementById('scanFallbackArea');
  if(!video) return; // screen changed before camera init finished

  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    showScanFallback('Camera access isn\'t supported in this browser.');
    return;
  }

  try{
    qrScanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }
    });
  } catch(err){
    const deniedMsgs = {
      NotAllowedError: 'Camera access was denied. Allow camera access in your browser settings, or use the PIN tab instead.',
      NotFoundError: 'No camera was found on this device. Use the PIN tab instead.',
    };
    showScanFallback(deniedMsgs[err.name] || 'Couldn\'t access the camera. Use the PIN tab instead.');
    return;
  }

  // Screen may have changed while the permission prompt was pending.
  if(currentScreen !== 'checkin' || !document.getElementById('qrVideo')){
    qrScanStream.getTracks().forEach(t=>t.stop());
    qrScanStream = null;
    return;
  }

  video.srcObject = qrScanStream;
  video.style.display = 'block';
  if(idleIcon) idleIcon.style.display = 'none';
  if(hint) hint.textContent = "Point your camera at the lecturer's QR code";

  qrScanLastResult = null;
  video.addEventListener('loadedmetadata', () => { qrScanRafId = requestAnimationFrame(scanFrame); }, { once: true });
}

function scanFrame(){
  const video = document.getElementById('qrVideo');
  const canvas = document.getElementById('qrScanCanvas');
  if(!video || !canvas || currentScreen !== 'checkin'){ return; }

  if(video.readyState === video.HAVE_ENOUGH_DATA){
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let code = null;
    try{
      code = jsQR(imageData.data, imageData.width, imageData.height);
    } catch(e){ /* malformed frame, ignore and try the next one */ }

    if(code && code.data && code.data !== qrScanLastResult){
      qrScanLastResult = code.data;
      handleScannedQrPayload(code.data);
      return; // stop the scan loop; handleScannedQrPayload decides what happens next
    }
  }
  qrScanRafId = requestAnimationFrame(scanFrame);
}

function handleScannedQrPayload(raw){
  const parts = String(raw).split('|');
  const [marker, token, courseCode] = parts;

  if(marker !== 'VUSAP' || !token){
    showToast("That doesn't look like a VUSAP attendance QR code");
    qrScanLastResult = null; // allow re-scanning immediately
    qrScanRafId = requestAnimationFrame(scanFrame);
    return;
  }
  if(!LIVE_SESSION.active){
    showToast("This session has ended");
    return;
  }
  if(courseCode !== LIVE_SESSION.courseCode){
    showToast("This QR code is for a different course");
    qrScanLastResult = null;
    qrScanRafId = requestAnimationFrame(scanFrame);
    return;
  }
  if(token !== LIVE_SESSION.token){
    // Token has rotated since this QR was generated/captured — exactly the
    // screenshot-reuse case the rotating QR is designed to catch.
    showToast("This QR code has expired — ask your lecturer to refresh it");
    qrScanLastResult = null;
    qrScanRafId = requestAnimationFrame(scanFrame);
    return;
  }

  stopQrScanner();
  showToast("QR code recognized");
  setTimeout(()=>completeCheckIn(), 400);
}

function showScanFallback(message){
  const hint = document.getElementById('scanHint');
  const fallback = document.getElementById('scanFallbackArea');
  const laser = document.getElementById('scanLaser');
  if(hint) hint.textContent = message;
  if(laser) laser.style.display = 'none';
  if(fallback){
    fallback.innerHTML = `
    <button class="btn btn-primary" style="margin-top:14px;" onclick="setCheckinMethod('pin')">${ICONS.keypad} Use PIN Instead</button>
    <button class="btn btn-ghost" style="margin-top:8px;" onclick="retryQrScanner()">${ICONS.refresh} Try Camera Again</button>`;
  }
}

function retryQrScanner(){
  const fallback = document.getElementById('scanFallbackArea');
  if(fallback) fallback.innerHTML = '';
  const laser = document.getElementById('scanLaser');
  if(laser) laser.style.display = '';
  const hint = document.getElementById('scanHint');
  if(hint) hint.textContent = 'Starting camera…';
  startQrScanner();
}

function stopQrScanner(){
  if(qrScanRafId){
    cancelAnimationFrame(qrScanRafId);
    qrScanRafId = null;
  }
  if(qrScanStream){
    qrScanStream.getTracks().forEach(t=>t.stop());
    qrScanStream = null;
  }
  qrScanLastResult = null;
}

function renderPinEntryArea(){
  const digits = State.pinEntry.padEnd(6,' ').split('');
  return `
  <div class="card card-pad">
    <div style="text-align:center; font-size:12.5px; color:var(--ink-soft); font-weight:600;">Enter the 6-digit code shown on the lecturer's screen</div>
    <div class="pin-display">
      ${digits.map(d=>`<div class="pin-digit-box ${d.trim()?'filled':''}">${d.trim()}</div>`).join('')}
    </div>
    <div class="keypad">
      ${[1,2,3,4,5,6,7,8,9].map(n=>`<button class="keypad-btn" onclick="pinPress('${n}')">${n}</button>`).join('')}
      <button class="keypad-btn empty"></button>
      <button class="keypad-btn" onclick="pinPress('0')">0</button>
      <button class="keypad-btn" onclick="pinBackspace()">⌫</button>
    </div>
  </div>`;
}

function pinPress(digit){
  if(State.pinEntry.length >= 6) return;
  State.pinEntry += digit;
  if(State.pinEntry.length === 6){
    rerenderCurrentScreen();
    setTimeout(()=>verifyPin(), 250);
    return;
  }
  rerenderCurrentScreen();
}

function pinBackspace(){
  State.pinEntry = State.pinEntry.slice(0,-1);
  rerenderCurrentScreen();
}

function verifyPin(){
  if(State.pinEntry === LIVE_SESSION.pin){
    completeCheckIn();
  } else {
    showToast("Incorrect code — check with your lecturer");
    State.pinEntry = "";
    rerenderCurrentScreen();
  }
}

async function completeCheckIn(){
  stopQrScanner();

  // Sept 2026 handoff, Part 2: run duplicate/mismatch detection BEFORE
  // touching any local state, so a second-session or wrong-class scan never
  // shows the optimistic "you're checked in" screen to begin with — it's
  // redirected straight to Submit Appeal instead. In local-only (mock) mode
  // resolveCheckInOutcome() returns 'proceed' immediately (no live await),
  // so this adds no delay for anyone not on the live backend.
  State.checkInVerifying = true;
  rerenderCurrentScreen();
  const outcome = await resolveCheckInOutcome();
  State.checkInVerifying = false;

  if(outcome.outcome === 'duplicate'){
    // Already have a row for this exact broadcast — they really are checked
    // in, just not from this scan. Show the same success state a first-time
    // check-in would, plus a toast clarifying why nothing new happened.
    State.hasCheckedInToday = true;
    rerenderCurrentScreen();
    showToast("You've already checked in to this session");
    return;
  }
  if(outcome.outcome === 'appeal'){
    redirectToAppealFromCheckIn(outcome);
    return;
  }

  State.hasCheckedInToday = true;

  // Gate 4: keep the local RECORDS list (same shape as its seeded mock
  // rows) in sync immediately, so any screen reading RECORDS reflects this
  // check-in right away regardless of whether the live write below
  // succeeds — this is the "existing in-memory RECORDS.push(...)" the live
  // write sits alongside; it didn't actually exist yet before this slice.
  RECORDS.unshift({
    date: new Date().toISOString().slice(0,10),
    reg: State.user?.id || State.user?.reg || '',
    name: State.user?.name || '',
    prog: State.user?.dept || '',
    code: LIVE_SESSION.courseCode,
    course: LIVE_SESSION.courseName,
    venue: LIVE_SESSION.room,
    status: 'present',
  });

  liveWriteAttendance(); // fire-and-forget — local check-in above already succeeded either way

  rerenderCurrentScreen();
  showToast(`Checked in to ${LIVE_SESSION.courseName}`, ICONS.checkCircle.replace(/width="\d+" height="\d+"/,'width="16" height="16"'));
}

// Sept 2026 handoff, Part 2: a duplicate-different-broadcast or class/mode
// mismatch doesn't write an attendance row at all — it redirects into the
// existing Submit Appeal flow instead, pre-filled with the course, today's
// date, and a reason hint, so the student can explain what happened rather
// than either silently failing or (worse) getting marked present against
// the wrong session. Reuses renderAppeals()/handleAppealSubmit() rather
// than building a parallel appeal path — navigate('appeals') renders the
// sheet's markup synchronously, so the fields are safe to fill in and the
// sheet safe to open immediately after, no extra wait needed.
function redirectToAppealFromCheckIn(outcome){
  navigate('appeals', { replace: true });
  const courseSel = document.getElementById('appealCourse');
  const dateInput = document.getElementById('appealDate');
  const reasonArea = document.getElementById('appealReason');
  if(courseSel) courseSel.value = LIVE_SESSION.courseCode;
  if(dateInput) dateInput.value = new Date().toISOString().slice(0,10);
  if(reasonArea) reasonArea.value = outcome.reason || '';
  openSheet('newAppealSheet');
  showToast("We couldn't check you in automatically — please review and submit this appeal");
}

// ============================================================
// LECTURER: START SESSION (QR + PIN generation)
// ============================================================

function renderStartSession(){
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('dashboard')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Live Session</div>
    </div>
  </div>
  <div class="content">
    <div class="info-box" style="text-align:center;">
      <div class="k">${LIVE_SESSION.courseCode} — ${LIVE_SESSION.courseName}</div>
      <div class="v" style="font-size:13px;">${LIVE_SESSION.room}</div>
    </div>

    <div class="card card-pad" style="align-items:center; display:flex; flex-direction:column; gap:14px;">
      <div class="qr-display-wrap">
        <div id="qrCanvasHolder" class="qr-code-box"></div>
      </div>
      <div style="display:flex; align-items:center; gap:8px; font-size:11.5px; color:var(--ink-faint); font-weight:600;">
        ${ICONS.refresh.replace(/<svg /,'<svg style="width:13px;height:13px;" ')} <span id="qrRotateLabel">Refreshes in ${LIVE_SESSION.tokenRotateSeconds}s</span>
      </div>
    </div>

    <div class="card card-pad" style="align-items:center; display:flex; flex-direction:column; gap:10px;">
      <div style="font-size:11.5px; font-weight:700; color:var(--ink-soft);">OR STUDENTS CAN ENTER THIS CODE</div>
      <div class="session-pin-display">
        ${LIVE_SESSION.pin.split('').map(d=>`<div class="session-pin-digit">${d}</div>`).join('')}
      </div>
    </div>

    <div class="status-chip-grid" style="grid-template-columns:repeat(2,1fr);">
      <div class="status-chip present"><div class="n" id="liveSessionCountdown">—</div><div class="l">Time Left</div></div>
      <div class="status-chip unmarked"><div class="n" id="liveCheckinCount">0</div><div class="l">Checked In</div></div>
    </div>

    <div class="card card-pad">
      <div class="section-title" style="margin-bottom:8px;">${ICONS.users} Checked In</div>
      <div id="liveRosterList">
        <div class="empty-state-sm">No check-ins yet</div>
      </div>
    </div>

    <button class="btn btn-ghost" onclick="endSession()">${ICONS.close} End Session Now</button>
  </div>`;
}

let sessionTickInterval = null;
let secondsUntilRotate = 0;

let ticksSinceCheckinCountRefresh = 0;

function startSessionTicker(){
  stopSessionTicker();
  secondsUntilRotate = LIVE_SESSION.tokenRotateSeconds;
  sessionTickInterval = setInterval(()=>{
    const elapsed = Math.floor((Date.now() - LIVE_SESSION.startedAt)/1000);
    const remaining = Math.max(0, LIVE_SESSION.windowSeconds - elapsed);
    const countdownEl = document.getElementById('liveSessionCountdown');
    if(countdownEl){
      countdownEl.textContent = remaining>0 ? `${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}` : 'Closed';
    }

    secondsUntilRotate -= 1;
    const rotateLabel = document.getElementById('qrRotateLabel');
    if(rotateLabel) rotateLabel.textContent = `Refreshes in ${Math.max(0, secondsUntilRotate)}s`;

    if(secondsUntilRotate <= 0){
      regenerateSessionToken();
      drawQrPlaceholder();
      liveWriteSession();
      secondsUntilRotate = LIVE_SESSION.tokenRotateSeconds;
    }

    if(remaining <= 0 || !LIVE_SESSION.active){
      stopSessionTicker();
    }
  }, 1000);
}

function stopSessionTicker(){
  if(sessionTickInterval){
    clearInterval(sessionTickInterval);
    sessionTickInterval = null;
  }
}

// Deliberately separate from startSessionTicker()/stopSessionTicker(): the
// QR-rotation ticker stops once the session's official window closes ("Closed"),
// but a check-in can still legitimately arrive after that point — the fraud
// detection built earlier allows late check-ins through, just flagged. If
// roster/count polling died along with the QR ticker (as it used to, sharing
// one interval), a genuinely late check-in like this would silently never
// appear on the Lecturer's screen, even though it's sitting right there in
// the database. This keeps polling for as long as the Lecturer stays on the
// Start Session screen, regardless of whether the window has closed.
let rosterPollInterval = null;

function startRosterPolling(){
  stopRosterPolling();
  ticksSinceCheckinCountRefresh = 0;
  rosterPollInterval = setInterval(()=>{
    ticksSinceCheckinCountRefresh += 1;
    if(ticksSinceCheckinCountRefresh >= 3){
      ticksSinceCheckinCountRefresh = 0;
      updateLiveCheckinCount();
      updateLiveRoster();
    }
  }, 1000);
}

function stopRosterPolling(){
  if(rosterPollInterval){
    clearInterval(rosterPollInterval);
    rosterPollInterval = null;
  }
}

function endSession(){
  LIVE_SESSION.active = false;
  stopSessionTicker();
  stopRosterPolling();
  // liveWriteSession() branches on LIVE_SESSION.liveSessionId to decide
  // UPDATE vs INSERT — it must run BEFORE that field is cleared below, or
  // it would incorrectly insert a new row instead of marking the real one
  // inactive, leaving the actual session permanently stuck as active in
  // the database (the exact class of bug this whole fix is closing).
  liveWriteSession();
  LIVE_SESSION.liveSessionId = null;
  LIVE_SESSION.serverStartedAt = null;
  LIVE_SESSION.mode = null;
  showToast("Session ended");
  navigate('dashboard');
}

// Entry point for the "Start Live Session" quick action (Sept 2026 handoff,
// Part 1, item 2). Two-step only when there's a real choice to make — the
// single-lecture case stays exactly as frictionless as before, no selection
// step added. If a session is already active, this just re-enters it rather
// than trying to start/pick again (picking a second course while one is
// live is already prevented at the row level by lectureListMarkup's grey-out).
function handleStartLiveSessionTap(){
  if(isLiveSessionActive()){
    navigate('startSession');
    return;
  }
  const todayLectures = getLecturerTodayLectures();
  if(todayLectures.length === 0){
    showToast("You have no lecture scheduled today");
    return;
  }
  if(todayLectures.length === 1){
    startSessionForLecture(todayLectures[0]);
    return;
  }
  openSheet('startSessionPickerSheet');
}

// Row-tap handler shared by the dashboard's Today's Lectures card and the
// picker sheet (lectureListMarkup) — both just resolve the code back to the
// lecture object and hand off to the same start flow.
function handleLectureRowTap(code){
  const lecture = getLecturerTodayLectures().find(l => l.code === code);
  if(!lecture) return;
  startSessionForLecture(lecture);
}

async function startSessionForLecture(lecture){
  LIVE_SESSION.windowSeconds = ATTENDANCE_POLICIES.sessionWindowMinutes * 60;
  LIVE_SESSION.tokenRotateSeconds = ATTENDANCE_POLICIES.qrRotateSeconds;
  // Sept 2026 handoff, Part 1: this is the fix for the session always being
  // hardcoded to CSC3103 regardless of which lecture was actually "today's"
  // one — LIVE_SESSION.courseCode/courseName/room previously were only ever
  // set from a resumed live broadcast row, never from the picked lecture.
  LIVE_SESSION.courseCode = lecture.code;
  LIVE_SESSION.courseName = lecture.name;
  LIVE_SESSION.room = lecture.room;
  // Needed once a course can have both a Day and Evening section on the
  // same day (e.g. CSC3103 at 08:00 and again at 17:00) — without this,
  // the "Live" badge matched on course code alone and lit up BOTH entries
  // simultaneously, since nothing distinguished which specific slot was
  // actually the one broadcasting. live_qr_sessions itself has no mode
  // column (this is purely a client-side display concern, not persisted),
  // so this is set directly from the lecture the Lecturer actually picked.
  LIVE_SESSION.mode = lecture.mode || null;

  // Sept 2026 handoff, Part 1: rediscover this course's own already-active
  // broadcast before minting a new one. Previously this unconditionally
  // blanked liveSessionId on every entry to Start Session — including the
  // Lecturer's own device simply reloading — forcing a brand-new broadcast
  // row every time. Combined with the old marked_at time-window roster
  // filter, that made every check-in from before the reload silently
  // disappear from the roster even though it was still perfectly valid.
  // Mirrors the Student side's liveFindActiveSession() use in
  // startStudentLiveSessionSync() — same helper, same idea, other role.
  const resumed = LIVE_BACKEND ? await liveFindActiveSession(LIVE_SESSION.courseCode) : null;
  if(resumed){
    applyLiveSessionRow(resumed);
    subscribeToLiveSession(LIVE_SESSION.courseCode);
  } else {
    LIVE_SESSION.active = true;
    // liveSessionId must reflect "a session is genuinely running" in BOTH
    // live and mock mode (isLiveSessionActive() checks it alongside
    // .active). Live mode overwrites this with the real DB id once
    // liveWriteSession()'s insert resolves below; mock mode has no such
    // insert, so without a synthetic marker here liveSessionId would stay
    // null forever and "genuinely active" could never be detected in mock
    // mode at all — which is the only mode this sandbox can actually test.
    LIVE_SESSION.liveSessionId = LIVE_BACKEND ? null : ('mock-' + Date.now());
    LIVE_SESSION.serverStartedAt = null; // set once liveWriteSession()'s insert returns the DB-assigned value
    LIVE_SESSION.startedAt = Date.now();
    regenerateSessionToken();
    if(LIVE_BACKEND){
      // Compliance classification must use the server-assigned started_at,
      // never this device's clock (see the "never send a client timestamp
      // for a compliance record" gotcha) — wait for the real write to
      // resolve, then classify against whatever the DB actually recorded.
      liveDeactivateOtherSessions(LIVE_SESSION.courseCode)
        .then(liveWriteSession)
        .then(() => recordLectureComplianceEvent(lecture));
    } else {
      // No live DB round trip to wait for in mock mode — LIVE_SESSION.startedAt
      // (this device's clock) is the only signal available at all, same
      // fallback checkFraudSignals() already relies on elsewhere.
      liveDeactivateOtherSessions(LIVE_SESSION.courseCode).then(liveWriteSession);
      recordLectureComplianceEvent(lecture);
    }
  }

  // schedulingSessionId is re-resolved either way — a fresh page load has no
  // memory of it regardless of whether the broadcast itself was resumed.
  LIVE_SESSION.schedulingSessionId = null;
  // Gate 4: pre-warm today's scheduling `sessions` row so attendance writes
  // (from students checking in moments later) don't have to race to resolve
  // it themselves. Fire-and-forget, same as the broadcast write above.
  liveEnsureSchedulingSession(LIVE_SESSION.courseCode).then(id => {
    LIVE_SESSION.schedulingSessionId = id;
    updateDebugPanel();
  });
  navigate('startSession');
}

// Sept 2026 handoff, Part 1, items 3-4: classify how this session's actual
// start compares to the lecture's scheduled slot, then notify the
// Admin/Registrar side and log an audit trail entry — for a genuinely NEW
// session start only (never a resume; reloading an already-live session
// shouldn't reclassify or re-notify for the same broadcast).
function recordLectureComplianceEvent(lecture){
  const range = parseLectureTimeRange(lecture.time);
  if(!range){
    console.warn(`recordLectureComplianceEvent: could not parse scheduled time "${lecture.time}" for ${lecture.code} — skipping compliance classification.`);
    return;
  }
  const actualStartMs = LIVE_SESSION.serverStartedAt ? new Date(LIVE_SESSION.serverStartedAt).getTime() : LIVE_SESSION.startedAt;
  const actualStart = new Date(actualStartMs);
  const status = classifyLectureCompliance(range.start, range.end, actualStart);

  const STATUS_META = {
    CL:  { label:'Conducted Lecture (CL)',     title:'On-time session started' },
    DL:  { label:'Delayed Lecture (DL)',       title:'Delayed session started' },
    LOT: { label:'Lecture Out of Time (LOT)',  title:'Out-of-time session started' },
  };
  const meta = STATUS_META[status];
  const body = `${State.user.name} started ${lecture.code} — ${lecture.name} at ${formatClockTime(actualStart)} (scheduled ${lecture.time}). Status: ${meta.label}.`;

  // Reuses the existing, already-robust Notifications system rather than a
  // new mechanism — same broadcast-to-role pattern already used for
  // high-severity fraud flags (see logSuspicion()). CL, DL, and LOT all
  // notify — the brief didn't describe CL as silent, and a positive
  // confirmation is useful too.
  pushNotification({
    recipientRole: 'registrar', recipientId: null, type: 'lecturerCompliance',
    title: `${meta.title} — ${lecture.code}`, body,
    courseCode: lecture.code, from: 'System', fromId: 'system',
  });
  // Logged independently of the notification above so there's a permanent
  // record regardless of whether the notification ever gets read/dismissed.
  logAuditEvent(
    State.user.id || State.user.staffId, State.user.name,
    `Lecture session ${status}`, lecture.code, body
  );
}

function qrPayloadForSession(){
  // Real QR payload: app marker, current rotating token, course code, session start.
  // The student-side scanner checks the token against the live session before
  // accepting it, which is what actually defeats a screenshotted/reused QR.
  return `VUSAP|${LIVE_SESSION.token}|${LIVE_SESSION.courseCode}|${LIVE_SESSION.startedAt}`;
}

function drawQrPlaceholder(){
  const holder = document.getElementById('qrCanvasHolder');
  if(!holder) return;
  try{
    const qr = qrcode(0, 'M'); // type 0 = auto-detect smallest size for the data
    qr.addData(qrPayloadForSession());
    qr.make();
    // createSvgTag renders crisp at any size, unlike a fixed-resolution canvas/table.
    holder.innerHTML = qr.createSvgTag({ scalable: true, margin: 4 });
    const svg = holder.querySelector('svg');
    if(svg){ svg.style.width = '100%'; svg.style.height = '100%'; svg.style.display = 'block'; }
  } catch(e){
    holder.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--absent);font-size:11px;font-weight:700;text-align:center;padding:10px;">QR generation failed</div>`;
  }
}

// ============================================================
// REGISTRAR: DASHBOARD
// ============================================================

function renderRegistrarDashboard(){
  return `
  <div class="app-header">
    <div class="brand-row">
      <div class="brand-id">
        <div class="brand-mark">${VU_LOGO_MARK}</div>
        <div class="brand-text">
          <div class="name">VUSAP</div>
          <div class="sub">Registrar's Office</div>
        </div>
      </div>
      <div class="header-actions">
        <button class="icon-btn notif-bell-btn" onclick="navigate('notifications')" style="position:relative;">${ICONS.bell}${unreadNotifCount()>0 ? `<span class='notif-badge'>${unreadNotifCount()}</span>` : ''}</button>
        <button class="avatar-chip" onclick="navigate('profile')" title="Profile">${initials(State.user.name)}</button>
      </div>
    </div>
  </div>
  <div class="content">
    <div class="greeting-card">
      <h2>Good evening, ${firstName(State.user.name)}</h2>
      <p>Registrar's Attendance Management Dashboard</p>
      <div class="greeting-tags">
        <span class="tag-pill">${State.user.staffId || ''}</span>
        <span class="tag-pill">${facultyName(State.user.facultyKey)}</span>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-tile">
        <div class="top"><span class="label">Faculty Students</span>
          <span class="stat-icon" style="background:#dbeafe; color:#1d4ed8;">${ICONS.users}</span></div>
        <div class="value">${scopedStudents().length}</div>
      </div>
      <div class="stat-tile">
        <div class="top"><span class="label">Total Lectures</span>
          <span class="stat-icon" style="background:#dcfce7; color:#16a34a;">${ICONS.book}</span></div>
        <div class="value">${scopedRecords().length}</div>
      </div>
      <div class="stat-tile">
        <div class="top"><span class="label">Attendance Rate</span>
          <span class="stat-icon" style="background:#fce7f3; color:#be185d;">${ICONS.trend}</span></div>
        <div class="value">${(() => {
          const recs = scopedRecords();
          if(!recs.length) return '—';
          const present = recs.filter(r=>r.status==='present'||r.status==='late').length;
          return Math.round((present/recs.length)*100) + '%';
        })()}</div>
      </div>
      <div class="stat-tile">
        <div class="top"><span class="label">Today's Records</span>
          <span class="stat-icon" style="background:#ffedd5; color:#c2410c;">${ICONS.clock}</span></div>
        <div class="value">0</div>
      </div>
    </div>

    <div class="card section-card">
      <div class="section-title">${ICONS.chart} ${facultyName(State.user.facultyKey).replace('Faculty of ','')} Attendance Breakdown</div>
      ${donutChart([
        {label:'Present', value:scopedRecords().filter(r=>r.status==='present').length, color:'#16a34a'},
        {label:'Late', value:scopedRecords().filter(r=>r.status==='late').length, color:'#d97706'},
        {label:'Absent', value:scopedRecords().filter(r=>r.status==='absent').length, color:'#dc2626'},
      ])}
    </div>

    <div class="card section-card">
      <div class="section-head-row">
        <div class="section-title" style="margin-bottom:0;">${ICONS.bell} Recent Submissions</div>
        <button class="link-mini" onclick="navigate('records')">View All ${ICONS.chevR}</button>
      </div>
      ${scopedRecentSubmissions().map(r=>`
      <div class="lecture-row" style="margin-bottom:8px;">
        <div>
          <div class="lecture-code" style="font-size:13px;">${r.name}</div>
          <div class="lecture-meta" style="margin-top:3px;">${r.code} · ${r.date}</div>
        </div>
        <span class="status-pill ${r.status}">${r.status[0].toUpperCase()+r.status.slice(1)}</span>
      </div>`).join('') || `<div class="empty-state-sm">No recent submissions in your faculty</div>`}
    </div>

    <a class="quick-action solid" onclick="navigate('dataAnalytics')">
      <div class="qa-icon">${ICONS.chart}</div>
      <div class="qa-text"><div class="t">Data Analytics & Reports</div><div class="s">Student attendance & lecturer compliance</div></div>
      <div class="chev">${ICONS.chevR}</div>
    </a>
    <a class="quick-action" onclick="navigate('appeals')">
      <div class="qa-icon">${ICONS.gavel}</div>
      <div class="qa-text"><div class="t">Appeals & Disputes</div><div class="s">${scopedAppeals().filter(a=>a.status==='pending').length} pending review</div></div>
      <div class="chev">${ICONS.chevR}</div>
    </a>
    <a class="quick-action" onclick="navigate('fraudCenter')">
      <div class="qa-icon" style="background:#dc2626;">${ICONS.flag}</div>
      <div class="qa-text"><div class="t">Fraud Center</div><div class="s">${scopedSuspicionLog().length} flagged check-ins to review</div></div>
      <div class="chev">${ICONS.chevR}</div>
    </a>
    <a class="quick-action" onclick="navigate('register')">
      <div class="qa-icon">${ICONS.users}</div>
      <div class="qa-text"><div class="t">Register</div><div class="s">Students & lecturers in your faculty</div></div>
      <div class="chev">${ICONS.chevR}</div>
    </a>
    <a class="quick-action" onclick="navigate('courseCatalog')">
      <div class="qa-icon" style="background:#b45309;">${ICONS.layers}</div>
      <div class="qa-text"><div class="t">Courses</div><div class="s">Create and edit courses in your faculty</div></div>
      <div class="chev">${ICONS.chevR}</div>
    </a>
  </div>`;
}

// ============================================================
// REGISTRAR: ATTENDANCE RECORDS
// ============================================================

// Sept 2026 handoff, Part 4: the old flat "renderRecords()" screen (no
// catalog, every scoped record dumped in one list) is gone — Registrar's
// "Records" bottom-nav tab now opens renderAttendanceCatalog() instead (see
// getScreenHTML's registrar branch), which catalogues by course and drills
// into this same shared block scoped to the selected course.
//
// Shared "stat chips + search/filter + attendance sheet" block, used by the
// plain Attendance Records screen (bottom-nav "Records" tab), the Student
// Attendance sub-section under Data Analytics & Reports, AND (Sept 2026
// handoff, Part 4) the course/faculty attendance catalog — kept as one
// function so none of them can drift apart. opts.exportControl lets a
// caller swap in real export buttons; opts.beforeList injects extra content
// (the analytics charts) between the stat chips and the search row;
// opts.records lets a caller (Part 4's catalog) pass an already
// course/faculty-scoped record set instead of the default scopedRecords().
//
// Sept 2026 handoff, Part 3: the list itself is now grouped PER STUDENT
// (tap a student to drill into their own attendance) rather than one flat
// row per individual record — see studentRecordSummaryRow() and
// openStudentRecordDrilldown() below.
function renderAttendanceRecordsBlock(opts){
  opts = opts || {};
  const records = opts.records || scopedRecords();
  const counts = {
    total: records.length,
    present: records.filter(r=>r.status==='present').length,
    late: records.filter(r=>r.status==='late').length,
    absent: records.filter(r=>r.status==='absent').length,
  };
  const byStudent = groupRecordsByStudent(records);
  const exportControl = opts.exportControl || `<button class="link-mini" onclick="showToast('Report exported')">${ICONS.download} Export</button>`;
  const beforeList = opts.beforeList || '';
  return `
  <div class="content">
    <div class="status-chip-grid">
      <div class="status-chip unmarked"><div class="n">${counts.total}</div><div class="l">Total</div></div>
      <div class="status-chip present"><div class="n">${counts.present}</div><div class="l">Present</div></div>
      <div class="status-chip late"><div class="n">${counts.late}</div><div class="l">Late</div></div>
      <div class="status-chip absent"><div class="n">${counts.absent}</div><div class="l">Absent</div></div>
    </div>

    ${beforeList}

    <div class="row gap-sm">
      <div class="search-wrap grow">
        ${ICONS.search}
        <input class="input" placeholder="Search student name or ID..." oninput="filterRecords()" id="recordsSearch" />
      </div>
      <button class="icon-btn" style="background:var(--surface); border:1.5px solid var(--line); color:var(--theme-primary); width:46px; height:46px; border-radius:var(--radius-sm); flex-shrink:0;" onclick="openSheet('recordsFilterSheet')">${ICONS.filter}</button>
    </div>

    <div class="card card-pad">
      <div class="section-head-row">
        <div class="section-title" style="margin-bottom:0;">${ICONS.records} Attendance Sheet</div>
        ${exportControl}
      </div>
      <div style="font-size:11px;color:var(--ink-faint);margin:-6px 0 10px;">Tap a student to see their full attendance breakdown</div>
      <div id="recordsList" style="display:flex; flex-direction:column; gap:10px;">
        ${byStudent.size ? Array.from(byStudent.entries()).map(([reg,recs])=>studentRecordSummaryRow(reg,recs)).join('') : `<div class="empty-state-sm">No attendance records in your faculty yet</div>`}
      </div>
    </div>
  </div>

  <div class="sheet" id="recordsFilterSheet">
    <div class="sheet-handle"></div>
    <div class="sheet-title">
      <span>Filter Records</span>
      <button onclick="closeSheet('recordsFilterSheet')">${ICONS.close}</button>
    </div>
    <div style="display:flex; flex-direction:column; gap:14px;">
      <div class="field">
        <label>Course</label>
        <select class="select" id="filterCourse">
          <option value="">All Courses</option>
          <option value="CSC3101">CSC3101 – Data Structures & Algorithms</option>
          <option value="CSC3102">CSC3102 – Database Systems</option>
          <option value="BAR4301">BAR4301 – Financial Accounting</option>
        </select>
      </div>
      <div class="field">
        <label>Status</label>
        <select class="select" id="filterStatus">
          <option value="">All Statuses</option>
          <option value="present">Present</option>
          <option value="late">Late</option>
          <option value="absent">Absent</option>
        </select>
      </div>
      <div class="field">
        <label>Date</label>
        <input class="input" type="date" id="filterDate" />
      </div>
      <div class="btn-row" style="margin-top:4px;">
        <button class="btn btn-ghost" onclick="clearRecordsFilter()">Clear</button>
        <button class="btn btn-primary" onclick="applyRecordsFilter()">Apply Filters</button>
      </div>
    </div>
  </div>

  <div class="sheet" id="studentRecordSheet">
    <div class="sheet-handle"></div>
    <div class="sheet-title">
      <span id="studentRecordSheetTitle">Attendance Detail</span>
      <button onclick="closeSheet('studentRecordSheet')">${ICONS.close}</button>
    </div>
    <div id="studentRecordBody" style="max-height:70vh; overflow-y:auto; -webkit-overflow-scrolling:touch;"></div>
  </div>`;
}

// ============================================================
// REGISTRAR: DATA ANALYTICS & REPORTS
// ============================================================
// Replaces the old standalone "Attendance Records", "Reports & Export" and
// "Lecturer Compliance" dashboard rows with one module split into two
// sub-sections. "Student Attendance" reuses renderAttendanceRecordsBlock()
// above (same list/search/filter as the plain Records screen) plus Chart.js
// comparison charts and a real export action (exportReport(), the same
// function "Reports & Export" already used — scoped via scopedRecords()).
// "Lecturer Compliance" reuses the existing renderCompliance() screen with
// its own export action added (exportComplianceReport() below).

function renderDataAnalyticsHub(){
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('dashboard')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Data Analytics & Reports</div>
    </div>
  </div>
  <div class="content">
    <a class="quick-action solid" onclick="navigate('analyticsAttendance')">
      <div class="qa-icon">${ICONS.records}</div>
      <div class="qa-text"><div class="t">Student Attendance</div><div class="s">Records, comparison charts & export</div></div>
      <div class="chev">${ICONS.chevR}</div>
    </a>
    <a class="quick-action" onclick="navigate('compliance')">
      <div class="qa-icon">${ICONS.scaleIcon}</div>
      <div class="qa-text"><div class="t">Lecturer Compliance</div><div class="s">Session delivery vs. expected & export</div></div>
      <div class="chev">${ICONS.chevR}</div>
    </a>
  </div>`;
}

function renderStudentAttendanceAnalytics(){
  const exportControl = `
    <div style="display:flex; gap:10px;">
      <button class="link-mini" onclick="exportReport('pdf')">${ICONS.fileText} PDF</button>
      <button class="link-mini" onclick="exportReport('excel')">${ICONS.fileSpreadsheet} CSV</button>
    </div>`;
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('dataAnalytics')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Student Attendance</div>
    </div>
  </div>
  ${renderAttendanceRecordsBlock({ exportControl, beforeList: renderStudentAttendanceChartsMarkup() })}`;
}

function renderStudentAttendanceChartsMarkup(){
  return `
  <div class="card section-card">
    <div class="section-title">${ICONS.chart} Students by Course</div>
    <div style="position:relative; height:230px;"><canvas id="chartStudentsByCourse"></canvas></div>
  </div>
  <div class="card section-card">
    <div class="section-title">${ICONS.users} Male vs Female Students</div>
    <div style="position:relative; height:220px;"><canvas id="chartGenderSplit"></canvas></div>
  </div>
  <div class="card section-card">
    <div class="section-title">${ICONS.records} Present vs Late vs Absent</div>
    <div style="position:relative; height:220px;"><canvas id="chartAttendanceStatus"></canvas></div>
  </div>
  <div class="card section-card">
    <div class="section-title">${ICONS.calendar} Students by Year & Semester</div>
    <div style="position:relative; height:220px;"><canvas id="chartYearSemester"></canvas></div>
  </div>`;
}

// Chart.js instances tied to the Student Attendance analytics screen. Kept
// in a module-level map (not re-created ad hoc) so re-entering the screen
// destroys the previous instances first — Chart.js throws "Canvas is
// already in use" if you construct a new Chart on a canvas that still has
// a live instance attached, which happens every time this screen is
// re-navigated to since navigate() replaces the canvas element itself.
let _analyticsCharts = {};
function destroyAnalyticsCharts(){
  Object.values(_analyticsCharts).forEach(c => { if(c) c.destroy(); });
  _analyticsCharts = {};
}

// Chart.js is vendored locally (chart.min.js, registered in the service
// worker's cache list) rather than loaded from a CDN, per the PWA's
// offline-first requirement — see sw.js's origin check. If it somehow
// failed to load, the rest of this screen (records list, export, search)
// still works fine; only the four canvases stay blank.
function renderStudentAnalyticsCharts(){
  if(typeof Chart === 'undefined') return;
  destroyAnalyticsCharts();

  const students = scopedStudents();
  const records = scopedRecords();
  const CHART_COLORS = ['#1d4ed8','#7e22a3','#0f766e','#d97706','#dc2626','#0891b2','#c026d3','#65a30d','#be185d','#475569','#9333ea','#0369a1','#b45309','#4d7c0f'];

  // 1) Students by course (programme)
  const byCourse = {};
  students.forEach(s => { byCourse[s.dept] = (byCourse[s.dept]||0) + 1; });
  const courseLabels = Object.keys(byCourse);
  const ctx1 = document.getElementById('chartStudentsByCourse');
  if(ctx1){
    _analyticsCharts.byCourse = new Chart(ctx1, {
      type: 'bar',
      data: { labels: courseLabels, datasets: [{ label:'Students', data: courseLabels.map(c=>byCourse[c]), backgroundColor: courseLabels.map((_,i)=>CHART_COLORS[i%CHART_COLORS.length]) }] },
      options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false } }, scales:{ x:{ ticks:{ autoSkip:false, maxRotation:60, minRotation:30, font:{ size:9 } } }, y:{ beginAtZero:true, ticks:{ precision:0 } } } }
    });
  }

  // 2) Gender split — 'gender' is synthetic/placeholder data (never inferred
  // from names), added to STUDENTS as part of this feature.
  const male = students.filter(s=>s.gender==='Male').length;
  const female = students.filter(s=>s.gender==='Female').length;
  const unset = students.length - male - female;
  const genderLabels = ['Male','Female'].concat(unset>0 ? ['Not set'] : []);
  const genderData = [male, female].concat(unset>0 ? [unset] : []);
  const ctx2 = document.getElementById('chartGenderSplit');
  if(ctx2){
    _analyticsCharts.gender = new Chart(ctx2, {
      type: 'pie',
      data: { labels: genderLabels, datasets: [{ data: genderData, backgroundColor: ['#1d4ed8','#be185d','#94a3b8'] }] },
      options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:'bottom', labels:{ boxWidth:12, font:{ size:11 } } } } }
    });
  }

  // 3) Present / Late / Absent — same RECORDS/attendance status data used
  // throughout the rest of the app (scopedRecords()).
  const present = records.filter(r=>r.status==='present').length;
  const late = records.filter(r=>r.status==='late').length;
  const absent = records.filter(r=>r.status==='absent').length;
  const ctx3 = document.getElementById('chartAttendanceStatus');
  if(ctx3){
    _analyticsCharts.status = new Chart(ctx3, {
      type: 'doughnut',
      data: { labels:['Present','Late','Absent'], datasets:[{ data:[present,late,absent], backgroundColor:['#16a34a','#d97706','#dc2626'] }] },
      options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:'bottom', labels:{ boxWidth:12, font:{ size:11 } } } } }
    });
  }

  // 4) Students by year & semester — grouped bars (year on the x-axis, one
  // series per semester) so both new fields show in a single chart.
  const years = ['Year 1','Year 2','Year 3'];
  const sem1 = years.map(y => students.filter(s=>s.year===y && s.semester==='Semester 1').length);
  const sem2 = years.map(y => students.filter(s=>s.year===y && s.semester==='Semester 2').length);
  const ctx4 = document.getElementById('chartYearSemester');
  if(ctx4){
    _analyticsCharts.yearSemester = new Chart(ctx4, {
      type: 'bar',
      data: { labels: years, datasets: [
        { label:'Semester 1', data: sem1, backgroundColor:'#1d4ed8' },
        { label:'Semester 2', data: sem2, backgroundColor:'#0f766e' },
      ] },
      options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:'bottom', labels:{ boxWidth:12, font:{ size:11 } } } }, scales:{ y:{ beginAtZero:true, ticks:{ precision:0 } } } }
    });
  }
}

// Sept 2026 handoff, Part 3: groups a flat records array by student reg,
// preserving first-seen order (RECORDS is already date-descending in the
// mock data, so this reads newest-first per student too). The single
// chokepoint every per-student view (Records, Data Analytics, and Part 4's
// course/faculty catalog) builds its list from.
function groupRecordsByStudent(records){
  const map = new Map();
  records.forEach(r => {
    if(!map.has(r.reg)) map.set(r.reg, []);
    map.get(r.reg).push(r);
  });
  return map;
}

// One row per student, aggregated across all of their records in this list.
// Attendance % shown here is the student's own on-file STUDENTS.pct (the
// same figure shown everywhere else in the app for that student) rather than
// a second, possibly-divergent percentage computed fresh from this thin
// RECORDS sample — a deliberate judgment call to avoid two numbers claiming
// to be "this student's attendance rate".
function studentRecordSummaryRow(reg, recs){
  const student = STUDENTS.find(s => s.reg === reg);
  const name = student ? student.name : recs[0].name;
  const prog = student ? student.dept : recs[0].prog;
  const pct = student ? student.pct : null;
  const hasPct = pct !== null && pct !== undefined;
  const cls = hasPct ? (pct >= ATTENDANCE_POLICIES.minAttendancePct ? 'good' : 'bad') : '';
  const codes = [...new Set(recs.map(r=>r.code))];
  const statuses = [...new Set(recs.map(r=>r.status))];
  const dates = recs.map(r=>r.date);
  return `
  <div class="student-card-row" data-record-summary-row data-search="${(name+' '+reg).toLowerCase()}" data-codes="${codes.join(' ')}" data-statuses="${statuses.join(' ')}" data-dates="${dates.join(' ')}" onclick="openStudentRecordDrilldown('${reg}')" style="cursor:pointer;">
    <div class="avatar">${initials(name)}</div>
    <div class="student-info">
      <div class="student-name">${name}</div>
      <div class="student-meta">${reg} · ${prog || '—'}</div>
      <div class="record-tags" style="margin-top:4px;">
        ${codes.slice(0,3).map(c=>`<span class="tag-mini">${c}</span>`).join('')}${codes.length>3 ? `<span class="tag-mini">+${codes.length-3}</span>` : ''}
      </div>
    </div>
    ${hasPct ? `<div class="attendance-pct ${cls}">${pct}%<span class="lbl">attendance</span></div>` : ''}
    <div class="chev">${ICONS.chevR}</div>
  </div>`;
}

function filterRecords(){
  const q = (document.getElementById('recordsSearch')?.value || '').toLowerCase();
  document.querySelectorAll('[data-record-summary-row]').forEach(row=>{
    applyRecordRowVisibility(row, q);
  });
  recountRecordsVisible();
}

function applyRecordRowVisibility(row, q){
  const course = document.getElementById('filterCourse')?.value || '';
  const status = document.getElementById('filterStatus')?.value || '';
  const date = document.getElementById('filterDate')?.value || '';
  const textMatch = !q || row.dataset.search.includes(q);
  const courseMatch = !course || row.dataset.codes.split(' ').includes(course);
  const statusMatch = !status || row.dataset.statuses.split(' ').includes(status);
  const dateMatch = !date || row.dataset.dates.split(' ').includes(date);
  const visible = textMatch && courseMatch && statusMatch && dateMatch;
  row.style.display = visible ? 'flex' : 'none';
  return visible;
}

function recountRecordsVisible(){
  let visible = 0;
  document.querySelectorAll('[data-record-summary-row]').forEach(row=>{
    if(row.style.display !== 'none') visible++;
  });
  toggleNoResultsState('recordsList', visible, 'Try adjusting your filters');
}

function applyRecordsFilter(){
  const q = (document.getElementById('recordsSearch')?.value || '').toLowerCase();
  document.querySelectorAll('[data-record-summary-row]').forEach(row=>applyRecordRowVisibility(row, q));
  recountRecordsVisible();
  closeSheet('recordsFilterSheet');
  showToast('Filters applied');
}

function clearRecordsFilter(){
  document.getElementById('filterCourse').value = '';
  document.getElementById('filterStatus').value = '';
  document.getElementById('filterDate').value = '';
  filterRecords();
}

// ============================================================
// PER-STUDENT ATTENDANCE DRILL-DOWN (Sept 2026 handoff, Part 3)
// ------------------------------------------------------------
// Tapping a student in the Attendance Sheet opens this instead of navigating
// away — same sheet-swap pattern used elsewhere (openAccountDetail, etc).
// Data is organized semester -> course -> individual dated entries. RECORDS
// itself has no semester or year field (and no student in this mock dataset
// has records spanning more than one year), so "year" is shown as header
// context (the student's own on-file STUDENTS.year) rather than a third
// nesting level with nothing real to divide on — a judgment call flagged in
// the handoff summary. Course is the one real grouping axis RECORDS
// actually has, so that's what's nested under semester.
// ============================================================

function openStudentRecordDrilldown(reg, recordsOverride){
  const title = document.getElementById('studentRecordSheetTitle');
  const student = STUDENTS.find(s => s.reg === reg);
  if(title) title.textContent = student ? student.name : reg;
  const body = document.getElementById('studentRecordBody');
  if(body) body.innerHTML = renderStudentRecordDrilldown(reg, recordsOverride);
  openSheet('studentRecordSheet');
}

function renderStudentRecordDrilldown(reg, recordsOverride){
  const student = STUDENTS.find(s => s.reg === reg);
  const recs = (recordsOverride || scopedRecords()).filter(r => r.reg === reg);
  const name = student ? student.name : (recs[0] ? recs[0].name : reg);
  const prog = student ? student.dept : (recs[0] ? recs[0].prog : '—');
  const semester = student ? (student.semester || 'Semester —') : 'Semester —';
  const year = student ? (student.year || 'Year —') : 'Year —';
  const pct = student ? student.pct : null;
  const hasPct = pct !== null && pct !== undefined;
  const cls = hasPct ? (pct >= ATTENDANCE_POLICIES.minAttendancePct ? 'good' : 'bad') : '';

  // Group this student's records by course, preserving first-seen (newest-
  // first, since RECORDS is date-descending) order.
  const byCourse = new Map();
  recs.forEach(r => {
    const key = r.code;
    if(!byCourse.has(key)) byCourse.set(key, { course: r.course, code: r.code, venue: r.venue, entries: [] });
    byCourse.get(key).entries.push(r);
  });

  return `
    <div style="display:flex; align-items:center; gap:12px; margin-bottom:14px;">
      <div class="avatar" style="width:48px; height:48px; font-size:16px;">${initials(name)}</div>
      <div>
        <div style="font-weight:800; font-size:15px;">${name}</div>
        <div style="font-size:12px; color:var(--ink-faint); margin-top:2px;">${reg} · ${prog || '—'}</div>
      </div>
    </div>
    <div class="info-box" style="margin-bottom:16px; display:flex; align-items:center; justify-content:space-between;">
      <div>
        <div class="k">Overall Attendance</div>
        <div class="v" style="font-size:13px;">${semester} · ${year}</div>
      </div>
      ${hasPct ? `<div class="attendance-pct ${cls}" style="position:static;">${pct}%<span class="lbl">attendance</span></div>` : `<div style="font-size:12px;color:var(--ink-faint);">no records</div>`}
    </div>
    ${byCourse.size ? Array.from(byCourse.values()).map(group => `
    <div class="day-group">
      <div class="day-header">
        <span>${ICONS.book.replace('viewBox="0 0 24 24"','viewBox="0 0 24 24" width="14" height="14" style="margin-right:6px;vertical-align:-2px;"')}${group.code} — ${group.course}</span>
        <span class="day-count">${group.entries.length} session${group.entries.length>1?'s':''}</span>
      </div>
      <div class="card card-pad" style="display:flex;flex-direction:column;gap:8px;">
        ${group.entries.map(e => `
        <div class="lecture-row" style="padding:8px 0;">
          <div>
            <div class="lecture-meta" style="margin-top:0;font-weight:700;color:var(--ink-soft);">${e.date}</div>
            <div class="lecture-meta">${ICONS.pin} ${e.venue}</div>
          </div>
          <span class="status-pill ${e.status}">${e.status[0].toUpperCase()+e.status.slice(1)}</span>
        </div>`).join('')}
      </div>
    </div>`).join('') : `<div class="empty-state-sm">No attendance records for this student yet</div>`}
  `;
}

// ============================================================
// ATTENDANCE RECORDS CATALOG (Sept 2026 handoff, Part 4)
// ------------------------------------------------------------
// Reorganizes how each role BROWSES INTO records, on top of the per-student
// drill-down Part 3 already built: Lecturer and Registrar catalog by course;
// Administrator catalogs by faculty, then by course within it. All three
// eventually land on the same renderAttendanceRecordsBlock() (Part 3's
// per-student list) scoped to the selected course, rather than a second,
// separate display being built for this.
//
// Screen ids: 'attendanceCatalog' (top level, all three roles — Registrar's
// existing bottom-nav 'records' tab and Administrator's new one both also
// route here; Lecturer reaches it from a dashboard quick action, having had
// no records-browsing screen at all before this), 'facultyRecordsCatalog'
// (Administrator-only middle level), 'courseRecords' (leaf, all three).
//
// _recordsCatalogFacultyKey/_recordsCatalogCourseCode are the selections
// carried between those screens — module-level state, per this codebase's
// established pattern (c.f. _lastStudentBannerMode), explicitly reset in
// logout() below so a fresh login never inherits a stale selection.
// ============================================================

let _recordsCatalogFacultyKey = null;
let _recordsCatalogCourseCode = null;

// A Lecturer's own records — RECORDS carries no lecturer field, so this
// goes through the same COURSES.lecturer proxy Part 1's studentsForLecturer()
// already uses, rather than introducing a second way to answer "this
// lecturer's own courses".
function recordsForLecturer(){
  const codes = new Set(coursesForLecturer().map(c => c.code));
  return scopedRecords().filter(r => codes.has(r.code));
}

function courseCatalogFromRecords(records){
  const map = new Map();
  records.forEach(r => {
    if(!map.has(r.code)) map.set(r.code, { code:r.code, course:r.course, count:0, present:0 });
    const e = map.get(r.code);
    e.count++;
    if(r.status === 'present') e.present++;
  });
  return Array.from(map.values()).sort((a,b) => a.code.localeCompare(b.code));
}

function facultyCatalogFromRecords(records){
  const map = new Map();
  // Seed every real faculty first, defaulting to 0 — without this, a
  // faculty with no attendance records yet (nothing unusual for a
  // newer/smaller faculty in the mock data) was entirely absent from this
  // catalog rather than showing with a "0 records" state, which is what an
  // Admin browsing the full faculty structure would actually expect.
  FACULTIES.forEach(f => map.set(f.key, { facultyKey: f.key, count: 0 }));
  records.forEach(r => {
    const fk = facultyKeyForProgrammeName(r.prog) || 'unassigned';
    if(!map.has(fk)) map.set(fk, { facultyKey:fk, count:0 });
    map.get(fk).count++;
  });
  return Array.from(map.values()).sort((a,b) => (a.facultyKey||'').localeCompare(b.facultyKey||''));
}

function catalogEntryRow(opts){
  // Shared row markup for both the faculty-level and course-level catalog
  // cards — just the icon/title/subtitle/count differ.
  return `
  <div class="lecture-row" onclick="${opts.onclick}" style="cursor:pointer;">
    <div style="flex:1; min-width:0;">
      <div class="lecture-code" style="font-size:13px;">${opts.title}</div>
      <div class="lecture-meta" style="margin-top:4px;">${opts.subtitle}</div>
    </div>
    <div style="text-align:right;flex-shrink:0;display:flex;align-items:center;gap:8px;">
      <span class="badge dept">${opts.count} record${opts.count!==1?'s':''}</span>
      <div class="chev">${ICONS.chevR}</div>
    </div>
  </div>`;
}

function renderAttendanceCatalog(){
  const isAdmin = State.role === 'administrator';
  const isLecturer = State.role === 'lecturer';
  const records = isLecturer ? recordsForLecturer() : scopedRecords();

  const body = isAdmin
    ? (() => {
        const entries = facultyCatalogFromRecords(records);
        return entries.length
          ? entries.map(e => catalogEntryRow({
              onclick: `openFacultyRecordsCatalog('${e.facultyKey}')`,
              title: e.facultyKey === 'unassigned' ? 'Unassigned' : facultyName(e.facultyKey),
              subtitle: 'Tap to see courses in this faculty',
              count: e.count,
            })).join('')
          : `<div class="empty-state-sm">No attendance records yet</div>`;
      })()
    : (() => {
        const entries = courseCatalogFromRecords(records);
        return entries.length
          ? entries.map(e => catalogEntryRow({
              onclick: `openCourseRecords('${e.code}')`,
              title: `${e.code} — ${e.course}`,
              subtitle: `${e.present} of ${e.count} present`,
              count: e.count,
            })).join('')
          : `<div class="empty-state-sm">${isLecturer ? "No attendance records for your courses yet" : "No attendance records yet"}</div>`;
      })();

  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('dashboard')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Attendance Records</div>
    </div>
  </div>
  <div class="content">
    <div style="font-size:12px;color:var(--ink-soft);margin:-4px 0 14px;">${isAdmin ? 'Catalogued by faculty, then by course' : 'Catalogued by course'}</div>
    <div class="card card-pad">
      <div style="display:flex;flex-direction:column;gap:10px;">${body}</div>
    </div>
  </div>`;
}

function openFacultyRecordsCatalog(facultyKey){
  _recordsCatalogFacultyKey = facultyKey;
  navigate('facultyRecordsCatalog');
}

function renderFacultyRecordsCatalog(){
  const fk = _recordsCatalogFacultyKey;
  const records = scopedRecords().filter(r => (facultyKeyForProgrammeName(r.prog) || 'unassigned') === fk);
  const entries = courseCatalogFromRecords(records);
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('records')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">${fk === 'unassigned' ? 'Unassigned' : facultyName(fk).replace('Faculty of ','')}</div>
    </div>
  </div>
  <div class="content">
    <div style="font-size:12px;color:var(--ink-soft);margin:-4px 0 14px;">Courses with attendance records in this faculty</div>
    <div class="card card-pad">
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${entries.length ? entries.map(e => catalogEntryRow({
          onclick: `openCourseRecords('${e.code}')`,
          title: `${e.code} — ${e.course}`,
          subtitle: `${e.present} of ${e.count} present`,
          count: e.count,
        })).join('') : `<div class="empty-state-sm">No attendance records for this faculty yet</div>`}
      </div>
    </div>
  </div>`;
}

function openCourseRecords(code){
  _recordsCatalogCourseCode = code;
  navigate('courseRecords');
}

function renderCourseRecords(){
  const code = _recordsCatalogCourseCode;
  const isLecturer = State.role === 'lecturer';
  const roleRecords = isLecturer ? recordsForLecturer() : scopedRecords();
  const records = roleRecords.filter(r => r.code === code);
  const sample = records[0];
  const backTarget = State.role === 'administrator' ? 'facultyRecordsCatalog'
    : State.role === 'lecturer' ? 'attendanceCatalog'
    : 'records';
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('${backTarget}')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">${code}${sample ? ' — ' + sample.course : ''}</div>
    </div>
  </div>
  ${renderAttendanceRecordsBlock({ records })}`;
}

// ============================================================
// REGISTRAR: SUSPICION LOG
// ============================================================

function renderFraudCenter(){
  const log = scopedSuspicionLog();
  const high = log.filter(s=>s.severity==='high').length;
  const medium = log.filter(s=>s.severity==='medium').length;
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('dashboard')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Fraud Center</div>
    </div>
  </div>
  <div class="content">
    <div class="status-chip-grid" style="grid-template-columns:repeat(3,1fr);">
      <div class="status-chip unmarked"><div class="n">${log.length}</div><div class="l">Total Flags</div></div>
      <div class="status-chip absent"><div class="n">${high}</div><div class="l">High</div></div>
      <div class="status-chip late"><div class="n">${medium}</div><div class="l">Medium</div></div>
    </div>

    <div style="display:flex; flex-direction:column; gap:10px;">
      ${log.map(s=>`
      <div class="suspicion-card">
        <div class="sic">${ICONS.flag.replace(/<svg /,'<svg style="width:17px;height:17px;" ')}</div>
        <div style="flex:1;">
          <div class="sname">${s.student}</div>
          <div class="sreason">${s.reason}</div>
          <div class="smeta">${s.course} · ${s.date} · ${s.deviceId}</div>
        </div>
        <span class="severity-pill ${s.severity}">${s.severity}</span>
      </div>`).join('') || `<div class="empty-state-sm">No fraud flags in your faculty</div>`}
    </div>
  </div>`;
}

// ============================================================
// REGISTRAR: REPORTS & EXPORT
// ============================================================

function renderReports(){
  const records = scopedRecords();
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('dashboard')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Reports & Export</div>
    </div>
  </div>
  <div class="content">
    <div class="field-row">
      <div class="field">
        <label>Course</label>
        <select class="select" id="reportCourse" onchange="updateReportPreview()">
          <option value="">All Courses</option>
          ${[...new Set(records.map(r=>r.code))].map(code=>{
            const sample = records.find(r=>r.code===code);
            return `<option value="${code}">${code} – ${sample.course}</option>`;
          }).join('')}
        </select>
      </div>
      <div class="field">
        <label>Date Range</label>
        <select class="select" id="reportRange" onchange="updateReportPreview()">
          <option value="week">This Week</option>
          <option value="month">This Month</option>
          <option value="term">This Term</option>
        </select>
      </div>
    </div>

    <div class="card card-pad">
      <div class="section-title">${ICONS.fileText} Export Format</div>
      <div style="display:flex; flex-direction:column; gap:10px;">
        <div class="report-option" onclick="exportReport('pdf')">
          <div class="ro-icon" style="background:#fee2e2; color:#dc2626;">${ICONS.fileText}</div>
          <div class="ro-text"><div class="t">Export as PDF</div><div class="s">Formatted report — opens print dialog</div></div>
          <div class="chev">${ICONS.chevR}</div>
        </div>
        <div class="report-option" onclick="exportReport('excel')">
          <div class="ro-icon" style="background:#dcfce7; color:#16a34a;">${ICONS.fileSpreadsheet}</div>
          <div class="ro-text"><div class="t">Export as CSV</div><div class="s">Raw data — open in Excel or Google Sheets</div></div>
          <div class="chev">${ICONS.chevR}</div>
        </div>
      </div>
    </div>

    <div class="card section-card">
      <div class="section-title">${ICONS.chart} Preview</div>
      <div id="reportPreviewInfo" style="font-size:11px; color:var(--ink-faint); margin-bottom:10px;">${records.length} total records — showing first 5</div>
      <div style="overflow-x:auto;">
        <table id="reportPreviewTable" style="width:100%; border-collapse:collapse; font-size:11px;">
          <thead><tr style="text-align:left; color:var(--ink-faint); border-bottom:1px solid var(--line);">
            <th style="padding:6px 8px;">Student</th><th style="padding:6px 8px;">Programme</th><th style="padding:6px 8px;">Course</th><th style="padding:6px 8px;">Status</th>
          </tr></thead>
          <tbody id="reportPreviewBody">
            ${records.slice(0,5).map(r=>`<tr style="border-bottom:1px solid var(--line);">
              <td style="padding:6px 8px; font-weight:600;">${r.name}</td>
              <td style="padding:6px 8px;">${r.prog}</td>
              <td style="padding:6px 8px;">${r.code}</td>
              <td style="padding:6px 8px;"><span class="status-pill ${r.status}">${r.status}</span></td>
            </tr>`).join('') || `<tr><td colspan="4" style="padding:14px 8px; text-align:center; color:var(--ink-faint);">No records to preview</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  </div>`;
}

function exportReport(format){
  const courseFilter = document.getElementById('reportCourse')?.value || '';
  const rangeFilter = document.getElementById('reportRange')?.value || 'term';
  const records = scopedRecords();

  const filtered = courseFilter ? records.filter(r => r.code === courseFilter) : records;

  if(filtered.length === 0){
    showToast("No records match your filters");
    return;
  }

  if(format === 'excel'){
    // Build a real CSV file from the actual attendance records
    const headers = ['Name','Registration No.','Programme','Course Code','Course','Status','Date'];
    const rows = filtered.map(r => [
      `"${r.name}"`,
      `"${r.reg || ''}"`,
      `"${r.prog || ''}"`,
      `"${r.code}"`,
      `"${r.course}"`,
      `"${r.status}"`,
      `"${r.date || ''}"`,
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vusap-attendance-${courseFilter||'all'}-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    logAuditEvent(State.user?.staffId||'system', State.user?.name||'System', 'Report exported', courseFilter||'all', `CSV, ${filtered.length} records`);
    showToast(`${filtered.length} records exported as CSV`, ICONS.download.replace(/width="\d+" height="\d+"/,'width="15" height="15"'));

  } else if(format === 'pdf'){
    // Build a formatted HTML table and print it as PDF via the browser's print dialog
    const courseLabel = courseFilter
      ? filtered[0]?.course || courseFilter
      : 'All Courses';
    const html = `<!DOCTYPE html><html><head><title>VUSAP Attendance Report</title>
    <style>
      body{font-family:sans-serif;font-size:12px;color:#111;padding:24px;}
      h1{font-size:18px;margin-bottom:4px;}
      .meta{color:#666;font-size:11px;margin-bottom:20px;}
      table{width:100%;border-collapse:collapse;}
      th{background:#1e293b;color:#fff;padding:8px 10px;text-align:left;font-size:11px;}
      td{padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:11px;}
      tr:nth-child(even){background:#f8fafc;}
      .present{color:#16a34a;font-weight:700;}
      .late{color:#d97706;font-weight:700;}
      .absent{color:#dc2626;font-weight:700;}
    </style></head><body>
    <h1>VUSAP Attendance Report</h1>
    <div class="meta">Victoria University · ${courseLabel} · Exported ${new Date().toLocaleDateString('en-GB')}</div>
    <table>
      <thead><tr><th>Name</th><th>Reg. No.</th><th>Programme</th><th>Course</th><th>Status</th><th>Date</th></tr></thead>
      <tbody>
        ${filtered.map(r=>`<tr>
          <td>${r.name}</td>
          <td>${r.reg||''}</td>
          <td>${r.prog||''}</td>
          <td>${r.code} — ${r.course}</td>
          <td class="${r.status}">${r.status.toUpperCase()}</td>
          <td>${r.date||''}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <script>window.onload=()=>window.print();<\/script>
    </body></html>`;
    const win = window.open('', '_blank');
    if(win){
      win.document.write(html);
      win.document.close();
    }
    logAuditEvent(State.user?.staffId||'system', State.user?.name||'System', 'Report exported', courseFilter||'all', `PDF, ${filtered.length} records`);
    showToast(`${filtered.length} records sent to print`, ICONS.fileText.replace(/width="\d+" height="\d+"/,'width="15" height="15"'));
  }
}

function updateReportPreview(){
  const courseFilter = document.getElementById('reportCourse')?.value || '';
  const records = scopedRecords();
  const filtered = courseFilter ? records.filter(r => r.code === courseFilter) : records;
  const body = document.getElementById('reportPreviewBody');
  const info = document.getElementById('reportPreviewInfo');
  if(info) info.textContent = `${filtered.length} records — showing first 5`;
  if(body){
    body.innerHTML = filtered.slice(0,5).map(r=>`<tr style="border-bottom:1px solid var(--line);">
      <td style="padding:6px 8px; font-weight:600;">${r.name}</td>
      <td style="padding:6px 8px;">${r.prog}</td>
      <td style="padding:6px 8px;">${r.code}</td>
      <td style="padding:6px 8px;"><span class="status-pill ${r.status}">${r.status}</span></td>
    </tr>`).join('') || `<tr><td colspan="4" style="padding:14px 8px; text-align:center; color:var(--ink-faint);">No records match</td></tr>`;
  }
}

// ============================================================
// ADMINISTRATOR: DASHBOARD (full system access)
// ============================================================

const SYSTEM_MODULES = [
  { id:'userManagement', label:'Register', sub:'View, enroll, edit, suspend, or reactivate accounts', icon:ICONS.userCog, color:'#1d4ed8', bg:'#dbeafe' },
  { id:'courses', label:'Courses', sub:'Create and assign courses', icon:ICONS.layers, color:'#b45309', bg:'#fef3c7' },
  { id:'policies', label:'Attendance Policies', sub:'Set minimum attendance, grace periods', icon:ICONS.gavel, color:'#9c2220', bg:'#fee2e2' },
  { id:'fraudThresholds', label:'Fraud Thresholds', sub:'Tune detection sensitivity', icon:ICONS.flag, color:'#dc2626', bg:'#fee2e2' },
  { id:'notifTemplates', label:'Notification Templates', sub:'Edit system message templates', icon:ICONS.megaphone, color:'#1d4ed8', bg:'#dbeafe' },
  { id:'sendNotification', label:'Send Notification', sub:'Compose and send to students or staff', icon:ICONS.bell, color:'#1d4ed8', bg:'#dbeafe' },
  { id:'systemSettings', label:'System Settings', sub:'General configuration', icon:ICONS.settings, color:'#475569', bg:'#f1f5f9' },
  { id:'auditSystem', label:'Audit System', sub:'Full system-wide audit trail', icon:ICONS.fileText, color:'#0f766e', bg:'#ccfbf1' },
  { id:'backups', label:'Backups', sub:'Schedule and restore backups', icon:ICONS.archive, color:'#475569', bg:'#f1f5f9' },
  { id:'database', label:'Database Management', sub:'Tables, migrations, integrity checks', icon:ICONS.database, color:'#9c2220', bg:'#fee2e2' },
];

function renderAdministratorDashboard(){
  return `
  <div class="app-header">
    <div class="brand-row">
      <div class="brand-id">
        <div class="brand-mark">${VU_LOGO_MARK}</div>
        <div class="brand-text">
          <div class="name">VUSAP</div>
          <div class="sub">System Administration</div>
        </div>
      </div>
      <div class="header-actions">
        <button class="icon-btn notif-bell-btn" onclick="navigate('notifications')" style="position:relative;">${ICONS.bell}${unreadNotifCount()>0 ? `<span class='notif-badge'>${unreadNotifCount()}</span>` : ''}</button>
        <button class="avatar-chip" onclick="navigate('profile')" title="Profile">${initials(State.user.name)}</button>
      </div>
    </div>
  </div>
  <div class="content">
    <div class="greeting-card">
      <h2>Good evening, ${firstName(State.user.name)}</h2>
      <p>Full system access — users, roles, and platform configuration.</p>
      <div class="greeting-tags">
        <span class="tag-pill">${State.user.staffId || ''}</span>
        <span class="tag-pill">Full Access</span>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-tile" onclick="navigate('register')" style="cursor:pointer;">
        <div class="top"><span class="label">Total Users</span>
          <span class="stat-icon" style="background:#dbeafe; color:#1d4ed8;">${ICONS.users}</span></div>
        <div class="value">${getStaffDirectory().length}</div>
      </div>
      <div class="stat-tile" onclick="navigate('roleAssignments')" style="cursor:pointer;">
        <div class="top"><span class="label">Active Roles</span>
          <span class="stat-icon" style="background:#f3e8ff; color:#7e22a3;">${ICONS.shield}</span></div>
        <div class="value">4</div>
      </div>
      <div class="stat-tile" onclick="navigate('facultiesProgrammes')" style="cursor:pointer;">
        <div class="top"><span class="label">Faculties</span>
          <span class="stat-icon" style="background:#ccfbf1; color:#0f766e;">${ICONS.building}</span></div>
        <div class="value">${FACULTIES.length}</div>
      </div>
      <div class="stat-tile">
        <div class="top"><span class="label">System Health</span>
          <span class="stat-icon" style="background:#dcfce7; color:#16a34a;">${ICONS.trend}</span></div>
        <div class="value">OK</div>
      </div>
    </div>

    <div class="card section-card">
      <div class="section-title">${ICONS.settings} System Modules</div>
      <div style="display:flex; flex-direction:column; gap:10px;">
        ${SYSTEM_MODULES.map(m=>`
        <div class="report-option" onclick="openSystemModule('${m.id}')">
          <div class="ro-icon" style="background:${m.bg}; color:${m.color};">${m.icon}</div>
          <div class="ro-text"><div class="t">${m.label}</div><div class="s">${m.sub}</div></div>
          <div class="chev">${ICONS.chevR}</div>
        </div>`).join('')}
      </div>
    </div>
  </div>`;
}

function openSystemModule(moduleId){
  if(moduleId === 'userManagement'){
    // Part 1 of the Sept 2026 handoff merged User Management into the
    // unified Register screen — this System Modules tile still exists as a
    // shortcut, it just points at the merged screen now.
    navigate('register');
    return;
  }
  if(moduleId === 'roleAssignments'){
    navigate('roleAssignments');
    return;
  }
  if(moduleId === 'faculties'){
    navigate('facultiesProgrammes');
    return;
  }
  if(moduleId === 'courses'){
    navigate('courseCatalog');
    return;
  }
  if(moduleId === 'policies'){
    navigate('attendancePolicies');
    return;
  }
  if(moduleId === 'fraudThresholds'){
    navigate('fraudThresholds');
    return;
  }
  if(moduleId === 'notifTemplates'){
    navigate('notifTemplates');
    return;
  }
  if(moduleId === 'sendNotification'){
    navigate('sendNotification');
    return;
  }
  if(moduleId === 'systemSettings'){
    navigate('systemSettings');
    return;
  }
  if(moduleId === 'auditSystem'){
    navigate('auditSystem');
    return;
  }
  if(moduleId === 'backups'){
    navigate('backups');
    return;
  }
  if(moduleId === 'database'){
    navigate('database');
    return;
  }
  // All known modules are wired above — this path should never be reached.
  console.warn('Unknown module id:', moduleId);
  showToast(`Unknown module: ${moduleId}`);
}

// ============================================================
// ADMINISTRATOR: STAFF / PEOPLE DIRECTORY
// ============================================================

const ROLE_BADGE_META = {
  student:        { label:"Student",       color:"#1d4ed8", bg:"#dbeafe" },
  lecturer:       { label:"Lecturer",      color:"#0f766e", bg:"#ccfbf1" },
  registrar:      { label:"Registrar",     color:"#7e22a3", bg:"#f3e8ff" },
  administrator:  { label:"Administrator", color:"#9c2220", bg:"#fee2e2" },
};

function openAccountDetail(personId){
  const all = getStaffDirectory();
  const person = all.find(p => p.id === personId);
  if(!person) return;

  const title = document.getElementById('accountDetailTitle');
  if(title) title.textContent = person.name;

  const body = document.getElementById('accountDetailBody');
  if(!body) return;

  const meta = ROLE_BADGE_META[person.role] || { label:person.role, color:"#475569", bg:"#f1f5f9" };
  const isSelf = State.user && (State.user.staffId === personId || State.user.reg === personId);

  let statusSection = '';
  let actionSection = '';

  if(!person.hasAccount){
    statusSection = `
      <div class="info-box" style="margin-bottom:14px;">
        <div class="k">Account status</div>
        <div class="v" style="font-size:14px; color:var(--ink-soft);">Not provisioned — no login has been issued yet</div>
      </div>`;
    actionSection = `
      <div style="font-size:12px; color:var(--ink-faint); line-height:1.5;">
        This person has an academic record but no VUSAP login. Provisioning bulk student accounts isn't available from this screen yet —
        use Register → Enroll Student for individual accounts.
      </div>`;
  } else if(isSelf){
    statusSection = `
      <div class="info-box" style="margin-bottom:14px;">
        <div class="k">Account status</div>
        <div class="v" style="font-size:14px; color:var(--present);">Active</div>
      </div>`;
    actionSection = `
      <div style="font-size:12px; color:var(--ink-faint); line-height:1.5;">
        You can't suspend your own account from here.
      </div>`;
  } else if(person.status === 'suspended'){
    statusSection = `
      <div class="info-box" style="margin-bottom:14px;">
        <div class="k">Account status</div>
        <div class="v" style="font-size:14px; color:#b91c1c;">Suspended</div>
      </div>`;
    actionSection = `
      <button class="btn btn-primary" onclick="reactivateAccount('${personId}')">${ICONS.check} Reactivate Account</button>`;
  } else {
    statusSection = `
      <div class="info-box" style="margin-bottom:14px;">
        <div class="k">Account status</div>
        <div class="v" style="font-size:14px; color:var(--present);">Active</div>
      </div>`;
    actionSection = `
      <button class="btn btn-ghost" style="color:var(--absent); border-color:#fecaca;" onclick="suspendAccount('${personId}')">${ICONS.close} Suspend Account</button>`;
  }

  body.innerHTML = `
    <div style="display:flex; align-items:center; gap:12px; margin-bottom:16px;">
      <div class="avatar" style="width:48px; height:48px; font-size:16px;">${initials(person.name)}</div>
      <div>
        <div style="font-weight:800; font-size:15px;">${person.name}</div>
        <div style="font-size:12px; color:var(--ink-faint); margin-top:2px;">${personId}</div>
      </div>
    </div>
    <div style="display:flex; gap:6px; margin-bottom:16px;">
      <span class="badge dept" style="background:${meta.bg};color:${meta.color};">${meta.label}</span>
      ${person.dept ? `<span class="badge dept">${person.dept}</span>` : ''}
    </div>
    ${statusSection}
    ${actionSection}
  `;

  openSheet('accountDetailSheet');
}

function suspendAccount(personId){
  const user = USERS[personId];
  if(!user) return;
  user.status = 'suspended';
  logAuditEvent(State.user?.staffId||State.pendingUserId||'system', State.user?.name||'System', 'Account suspended', personId, `${user.name} account suspended`);
  closeSheet('accountDetailSheet');
  showToast(`${user.name}'s account has been suspended`);
  navigate('register', { replace: true });
}

function reactivateAccount(personId){
  const user = USERS[personId];
  if(!user) return;
  user.status = 'active';
  logAuditEvent(State.user?.staffId||State.pendingUserId||'system', State.user?.name||'System', 'Account reactivated', personId, `${user.name} account reactivated`);
  closeSheet('accountDetailSheet');
  showToast(`${user.name}'s account has been reactivated`);
  navigate('register', { replace: true });
}

// ============================================================
// REGISTER: account creation + lifecycle (Enroll Student is in the
// SHARED: REGISTER block above; this is Create Account — Lecturer/
// Registrar/Administrator — and the account-detail suspend/reactivate
// sheet above). Both renderStaffDirectory() and renderUserManagement()
// (the two screens Register replaced) are gone — their read-only catalog
// and account-lifecycle roles are now one screen, scoped per role in
// scopedRegisterPeople()/canManagePerson().
// ============================================================

function renderCreateAccountFormBody(){
  // Sept 2026 handoff, Part 1: Registrars can now create/edit Lecturer
  // accounts (a genuine new capability — they previously could only enroll
  // students) but still can't create fellow Registrars or Administrators,
  // so the role picker is locked to Lecturer for them rather than merely
  // defaulted to it.
  const isRegistrar = State.role === 'registrar';
  return `
    <div style="font-size:12px;color:var(--ink-soft);margin:-8px 0 16px;">${isRegistrar ? 'Registrars can create Lecturer accounts here. Students are created from Enroll Student instead.' : 'Students are created from Enroll Student instead, since enrollment also needs a programme and year.'}</div>
    <form id="createAccountForm" onsubmit="return submitCreateAccount(event)" style="display:flex;flex-direction:column;gap:14px;">
      <div class="field">
        <label>Role <span class="req">*</span></label>
        <select class="select" id="createAccountRole" ${isRegistrar ? 'disabled' : ''}>
          <option value="lecturer">Lecturer</option>
          ${!isRegistrar ? `<option value="registrar">Registrar</option><option value="administrator">Administrator</option>` : ''}
        </select>
      </div>
      <div class="field">
        <label>Full Name <span class="req">*</span></label>
        <input class="input" id="createAccountName" placeholder="e.g. Dr. Jane Mbabazi" required />
      </div>
      <div class="field">
        <label>Email</label>
        <input class="input" type="email" id="createAccountEmail" placeholder="Auto-generated if left blank" />
      </div>
      <div class="field" id="createAccountDeptField">
        <label>Department</label>
        <input class="input" id="createAccountDept" placeholder="e.g. Computer Science" />
      </div>
      <div class="btn-row" style="margin-top:6px;">
        <button type="button" class="btn btn-ghost" onclick="closeSheet('createAccountSheet')">Cancel</button>
        <button type="submit" class="btn btn-primary">${ICONS.check} Create Account</button>
      </div>
    </form>`;
}

function openCreateAccountSheet(){
  openSheet('createAccountSheet');
}

function submitCreateAccount(e){
  e.preventDefault();
  const role = document.getElementById('createAccountRole')?.value;
  const name = document.getElementById('createAccountName')?.value.trim();
  const email = document.getElementById('createAccountEmail')?.value.trim();
  const dept = document.getElementById('createAccountDept')?.value.trim();

  // Belt-and-suspenders: the role <select> is already disabled/locked to
  // 'lecturer' for Registrars in the form itself, but a disabled <select>'s
  // value is still readable (and, in principle, forgeable) via JS, so this
  // is the real enforcement point, not just the UI affordance.
  if(State.role === 'registrar' && role !== 'lecturer'){
    showToast('Registrars can only create Lecturer accounts');
    return false;
  }

  const result = createStaffAccount(role, name, email, dept);
  if(result.error){
    showToast(result.error);
    return false;
  }

  showCreateAccountConfirmation(name, result.id, result.tempPassword, role);
  return false;
}

function showCreateAccountConfirmation(name, id, tempPassword, role){
  // Swap the sheet's content in place (same reasoning as the enroll-student
  // flow): closing and reopening a second sheet on the same tick fights with
  // the back-button history bookkeeping.
  const title = document.getElementById('createAccountTitle');
  if(title) title.textContent = 'Account Created';
  const body = document.getElementById('createAccountBody');
  if(body){
    const roleLabel = ROLE_BADGE_META[role]?.label || role;
    const followUp = role === 'registrar'
      ? `<div style="font-size:11.5px; color:var(--ink-soft); line-height:1.5; margin-top:10px;">${name} isn't assigned to a faculty yet. Seat them from Role Assignments when you're ready.</div>`
      : '';
    body.innerHTML = `
      <div class="empty-state" style="padding:6px 0 4px;">
        ${ICONS.checkCircle.replace(/width="\d+" height="\d+"/,'width="36" height="36"')}
        <div class="t" style="margin-top:12px;">${name} added as ${roleLabel}</div>
        <div class="s">${id}</div>
      </div>
      <div class="info-box" style="margin-top:6px;">
        <div class="k">One-time temporary password</div>
        <div class="v" style="font-size:20px; letter-spacing:1px; font-family:monospace;">${tempPassword}</div>
      </div>
      <div style="font-size:11.5px; color:var(--ink-soft); line-height:1.5; margin-top:12px;">
        Share this with them through a secure channel. It's shown only once and won't appear anywhere else.
        They'll be asked to set their own password the first time they sign in.
      </div>
      ${followUp}
      <button class="btn btn-primary" style="margin-top:16px;" onclick="closeCreateAccountSheetAndReset()">Done</button>
    `;
  }
}

function closeCreateAccountSheetAndReset(){
  closeSheet('createAccountSheet');
}

// Same centralized reset pattern as the enroll-student sheet: revert to a
// fresh form after closing, regardless of how the sheet was closed.
const _resetSheetContentIfNeededBase = resetSheetContentIfNeeded;
resetSheetContentIfNeeded = function(sheetId){
  _resetSheetContentIfNeededBase(sheetId);
  if(sheetId === 'createAccountSheet'){
    setTimeout(()=>{
      const title = document.getElementById('createAccountTitle');
      if(title) title.textContent = 'Create Account';
      const body = document.getElementById('createAccountBody');
      if(body) body.innerHTML = renderCreateAccountFormBody();
    }, 250);
  }
  if(sheetId === 'accountDetailSheet' || sheetId === 'createAccountSheet'){
    // Either sheet closing should refresh the underlying list so a status
    // change or a new account shows up without a full screen reload. (Most
    // of the time this is already redundant — suspendAccount/reactivateAccount
    // navigate('register', {replace:true}) themselves — but createAccountSheet's
    // "Done" close path doesn't re-navigate, so this is what actually shows
    // a freshly-created account without a manual refresh.)
    const list = document.getElementById('registerList');
    if(list && typeof scopedRegisterPeople === 'function'){
      const people = scopedRegisterPeople();
      if(people.length) list.innerHTML = people.map(p=>registerPersonRow(p)).join('');
    }
  }
};

// ============================================================
// ADMINISTRATOR: ROLE ASSIGNMENTS (Registrar <-> Faculty)
// ============================================================
// First concrete feature of the "Role Assignments" module: Registrars are
// faculty-scoped (see reassignRegistrar above), so the Administrator needs a
// real way to change who holds that seat per faculty. Future role-scope
// changes (e.g. Lecturer course assignment) can join this screen later.

function registrarForFaculty(facultyKey){
  return Object.entries(USERS).find(([id, u]) => u.role === 'registrar' && u.facultyKey === facultyKey);
}

function seatlessRegistrars(){
  return Object.entries(USERS).filter(([id, u]) => u.role === 'registrar' && !u.facultyKey);
}

function renderRoleAssignments(){
  const seatless = seatlessRegistrars();
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('dashboard')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Role Assignments</div>
    </div>
  </div>
  <div class="content">
    <div class="empty-state-sm" style="background:var(--unmarked-bg); border-radius:var(--radius-md); padding:14px; text-align:left; color:var(--ink-soft); font-size:12px; line-height:1.5; font-weight:500;">
      ${ICONS.shield.replace(/<svg /,'<svg style="width:14px;height:14px;vertical-align:-2px;" ')} <strong>Every faculty has exactly one Registrar.</strong> Reassign below to move someone to a different faculty, fill a vacancy, or swap in someone else.
    </div>

    ${seatless.length ? `
    <div class="empty-state-sm" style="background:var(--late-bg); border-radius:var(--radius-md); padding:14px; text-align:left; color:var(--late); font-size:12px; line-height:1.5; font-weight:600; margin-top:10px;">
      ${ICONS.flag.replace(/<svg /,'<svg style="width:14px;height:14px;vertical-align:-2px;" ')} ${seatless.length} Registrar${seatless.length>1?'s':''} ${seatless.length>1?'have':'has'} no faculty assigned: ${seatless.map(([id,u])=>u.name).join(', ')}. Assign them to a faculty below.
    </div>` : ''}

    <div class="card card-pad" style="margin-top:14px;">
      <div class="section-title">${ICONS.building} Faculties</div>
      <div id="roleAssignmentsList" style="display:flex; flex-direction:column; gap:10px;">
        ${FACULTIES.map(fac => facultyRegistrarRow(fac)).join('')}
      </div>
    </div>
  </div>

  <div class="sheet" id="reassignSheet">
    <div class="sheet-handle"></div>
    <div class="sheet-title">
      <span id="reassignSheetTitle">Reassign Registrar</span>
      <button onclick="closeSheet('reassignSheet')">${ICONS.close}</button>
    </div>
    <div id="reassignSheetBody"></div>
  </div>`;
}

function facultyRegistrarRow(fac){
  const found = registrarForFaculty(fac.key);
  const [regId, regUser] = found || [null, null];
  const vacant = !regUser;
  return `
  <div class="lecture-row" style="flex-direction:column; align-items:stretch; gap:10px; ${vacant ? 'border-color:var(--late);' : ''}">
    <div>
      <div class="lecture-code" style="font-size:13px;">${fac.name}</div>
      <div class="lecture-meta" style="margin-top:5px; ${vacant ? 'color:var(--late); font-weight:700;' : ''}">${regUser ? `${regUser.name} · ${regId}` : 'Vacant — no Registrar assigned'}</div>
    </div>
    <button class="btn ${vacant ? 'btn-primary' : 'btn-ghost'}" style="padding:9px 14px; font-size:12px;" onclick="openReassignSheet('${fac.key}')">${(vacant ? ICONS.plus : ICONS.refresh).replace(/<svg /,'<svg style="width:13px;height:13px;" ')} ${vacant ? 'Assign Registrar' : 'Reassign'}</button>
  </div>`;
}

function openReassignSheet(facultyKey){
  const fac = FACULTIES.find(f => f.key === facultyKey);
  const [currentId, currentUser] = registrarForFaculty(facultyKey) || [null, null];
  const allRegistrars = Object.entries(USERS).filter(([id, u]) => u.role === 'registrar' && id !== currentId);
  // Seatless registrars are the obvious first choice for filling a vacancy —
  // list them first so Admin isn't left wondering where a displaced person went.
  const seatless = allRegistrars.filter(([id, u]) => !u.facultyKey);
  const assigned = allRegistrars.filter(([id, u]) => u.facultyKey);

  const title = document.getElementById('reassignSheetTitle');
  if(title) title.textContent = `${currentUser ? 'Reassign' : 'Assign'} — ${fac.name.replace('Faculty of ','')}`;

  const body = document.getElementById('reassignSheetBody');
  if(body){
    body.innerHTML = `
      <div class="info-box" style="margin-bottom:14px;">
        <div class="k">Currently assigned</div>
        <div class="v" style="font-size:14px;">${currentUser ? `${currentUser.name} (${currentId})` : 'Nobody — this faculty is vacant'}</div>
      </div>
      <div class="field">
        <label>Choose a Registrar for this faculty</label>
        <select class="select" id="reassignPicker">
          <option value="">Select a Registrar...</option>
          ${seatless.length ? `<optgroup label="Awaiting a faculty">
            ${seatless.map(([id, u]) => `<option value="${id}">${u.name} (${id}) — unassigned</option>`).join('')}
          </optgroup>` : ''}
          ${assigned.length ? `<optgroup label="Move from another faculty">
            ${assigned.map(([id, u]) => `<option value="${id}">${u.name} (${id}) — currently ${facultyName(u.facultyKey).replace('Faculty of ','')}</option>`).join('')}
          </optgroup>` : ''}
        </select>
      </div>
      <div class="btn-row" style="margin-top:16px;">
        <button type="button" class="btn btn-ghost" onclick="closeSheet('reassignSheet')">Cancel</button>
        <button type="button" class="btn btn-primary" onclick="confirmReassignRegistrar('${facultyKey}')">${ICONS.check} Confirm</button>
      </div>
    `;
  }
  openSheet('reassignSheet');
}

function confirmReassignRegistrar(facultyKey){
  const picked = document.getElementById('reassignPicker')?.value;
  if(!picked){
    showToast("Select a Registrar to assign first");
    return;
  }
  const displacedEntry = registrarForFaculty(facultyKey);
  const wasSeatless = !USERS[picked].facultyKey;

  reassignRegistrar(picked, facultyKey, State.user.name);

  // The faculty being moved INTO may have had its own Registrar already —
  // that person doesn't get deleted, but they now have no faculty until
  // reassigned themselves. Surface this clearly rather than silently
  // leaving a dangling registrar with no scope.
  let displacedName = null;
  if(displacedEntry && displacedEntry[0] !== picked){
    USERS[displacedEntry[0]].facultyKey = null;
    displacedName = displacedEntry[1].name;
  }

  closeSheet('reassignSheet');
  const movedName = USERS[picked].name;
  const facLabel = facultyName(facultyKey).replace('Faculty of ','');
  if(displacedName){
    showToast(`${movedName} is now Registrar for ${facLabel}. ${displacedName} now has no faculty.`);
  } else if(wasSeatless){
    showToast(`${movedName} is now Registrar for ${facLabel}`);
  } else {
    showToast(`${movedName} moved to ${facLabel}`);
  }

  // Re-render the whole screen (not just the list) so the seatless-registrar
  // warning banner at the top reflects the new state too.
  navigate('roleAssignments', { replace: true });
}

// ============================================================
// ADMINISTRATOR: FACULTIES & PROGRAMMES
// ============================================================

function renderFacultiesProgrammes(){
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('dashboard')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Faculties & Programmes</div>
    </div>
  </div>
  <div class="content" style="padding-bottom:90px;">
    <div class="empty-state-sm" style="background:var(--unmarked-bg); border-radius:var(--radius-md); padding:14px; text-align:left; color:var(--ink-soft); font-size:12px; line-height:1.5; font-weight:500;">
      ${ICONS.building.replace(/<svg /,'<svg style="width:14px;height:14px;vertical-align:-2px;" ')} <strong>Faculty → Programme → Course → Class</strong> is the academic hierarchy everything else (Registrars, students, reports) is scoped to. Deleting a faculty or programme is blocked while it still has programmes or students attached.
    </div>

    <div id="facultiesList" style="display:flex; flex-direction:column; gap:12px; margin-top:14px;">
      ${FACULTIES.map(fac => facultyCard(fac)).join('')}
    </div>
  </div>
  <div class="sticky-footer">
    <div class="sticky-footer-inner" style="padding:8px;">
      <button class="btn btn-primary" onclick="openFacultyFormSheet()">${ICONS.plus} Add Faculty</button>
    </div>
  </div>

  <div class="sheet" id="facultyFormSheet">
    <div class="sheet-handle"></div>
    <div class="sheet-title">
      <span id="facultyFormTitle">Add Faculty</span>
      <button onclick="closeSheet('facultyFormSheet')">${ICONS.close}</button>
    </div>
    <div id="facultyFormBody"></div>
  </div>

  <div class="sheet" id="programmeFormSheet">
    <div class="sheet-handle"></div>
    <div class="sheet-title">
      <span id="programmeFormTitle">Add Programme</span>
      <button onclick="closeSheet('programmeFormSheet')">${ICONS.close}</button>
    </div>
    <div id="programmeFormBody"></div>
  </div>`;
}

function facultyCard(fac){
  const progs = PROGRAMMES.filter(p => p.facultyKey === fac.key);
  const studentCount = STUDENTS.filter(s => s.facultyKey === fac.key).length;
  return `
  <div class="card card-pad" data-faculty-card="${fac.key}">
    <div class="section-head-row">
      <div style="flex:1; min-width:0;">
        <div class="lecture-code" style="font-size:14px;">${fac.name}</div>
        <div class="lecture-meta" style="margin-top:4px;">${progs.length} programme${progs.length!==1?'s':''} · ${studentCount} student${studentCount!==1?'s':''}</div>
      </div>
      <div style="display:flex; gap:6px; flex-shrink:0;">
        <button class="icon-btn" style="width:34px;height:34px;background:var(--unmarked-bg);" onclick="openFacultyFormSheet('${fac.key}')" title="Edit">${ICONS.edit.replace(/<svg /,'<svg style="width:15px;height:15px;" ')}</button>
        <button class="icon-btn" style="width:34px;height:34px;background:#fee2e2;color:#b91c1c;" onclick="confirmDeleteFaculty('${fac.key}')" title="Delete">${ICONS.close.replace(/<svg /,'<svg style="width:15px;height:15px;" ')}</button>
      </div>
    </div>

    <div style="display:flex; flex-direction:column; gap:8px; margin-top:10px;">
      ${progs.map(p => programmeRow(p)).join('') || `<div class="empty-state-sm">No programmes yet</div>`}
    </div>

    <button class="btn btn-ghost" style="margin-top:10px; padding:9px; font-size:12px;" onclick="openProgrammeFormSheet(null, '${fac.key}')">${ICONS.plus} Add Programme</button>
  </div>`;
}

function programmeRow(p){
  const studentCount = STUDENTS.filter(s => s.deptKey === p.key).length;
  return `
  <div class="lecture-row" style="padding:10px 12px;">
    <div style="flex:1; min-width:0;">
      <div style="font-size:12.5px; font-weight:700;">${p.name}</div>
      <div class="lecture-meta" style="margin-top:3px;">${p.codePrefix} · ${studentCount} student${studentCount!==1?'s':''}</div>
    </div>
    <div style="display:flex; gap:6px; flex-shrink:0;">
      <button class="icon-btn" style="width:30px;height:30px;background:var(--unmarked-bg);" onclick="openProgrammeFormSheet('${p.key}')" title="Edit">${ICONS.edit.replace(/<svg /,'<svg style="width:13px;height:13px;" ')}</button>
      <button class="icon-btn" style="width:30px;height:30px;background:#fee2e2;color:#b91c1c;" onclick="confirmDeleteProgramme('${p.key}')" title="Delete">${ICONS.close.replace(/<svg /,'<svg style="width:13px;height:13px;" ')}</button>
    </div>
  </div>`;
}

function rerenderFacultiesList(){
  const list = document.getElementById('facultiesList');
  if(list) list.innerHTML = FACULTIES.map(fac => facultyCard(fac)).join('');
}

function openFacultyFormSheet(facultyKey){
  const fac = facultyKey ? FACULTIES.find(f => f.key === facultyKey) : null;
  const title = document.getElementById('facultyFormTitle');
  if(title) title.textContent = fac ? 'Edit Faculty' : 'Add Faculty';

  const body = document.getElementById('facultyFormBody');
  if(body){
    body.innerHTML = `
      <div class="field">
        <label>Faculty Name <span class="req">*</span></label>
        <input class="input" id="facultyNameInput" value="${fac ? fac.name : ''}" placeholder="e.g. Faculty of Law" />
      </div>
      <div class="btn-row" style="margin-top:16px;">
        <button type="button" class="btn btn-ghost" onclick="closeSheet('facultyFormSheet')">Cancel</button>
        <button type="button" class="btn btn-primary" onclick="submitFacultyForm(${fac ? `'${fac.key}'` : 'null'})">${ICONS.check} ${fac ? 'Save' : 'Add Faculty'}</button>
      </div>
    `;
  }
  openSheet('facultyFormSheet');
}

function submitFacultyForm(facultyKey){
  const name = document.getElementById('facultyNameInput')?.value.trim();
  if(!name){
    showToast("Enter a faculty name");
    return;
  }
  const result = facultyKey ? renameFaculty(facultyKey, name) : createFaculty(name);
  if(result.error){
    showToast(result.error);
    return;
  }
  closeSheet('facultyFormSheet');
  showToast(facultyKey ? `Faculty renamed to ${name}` : `${name} added`);
  navigate('facultiesProgrammes', { replace: true });
}

function confirmDeleteFaculty(facultyKey){
  const fac = FACULTIES.find(f => f.key === facultyKey);
  if(!fac) return;
  const result = deleteFaculty(facultyKey);
  if(result.error){
    showToast(result.error);
    return;
  }
  showToast(`${fac.name} deleted`);
  navigate('facultiesProgrammes', { replace: true });
}

function openProgrammeFormSheet(programmeKey, defaultFacultyKey){
  const prog = programmeKey ? PROGRAMMES.find(p => p.key === programmeKey) : null;
  const title = document.getElementById('programmeFormTitle');
  if(title) title.textContent = prog ? 'Edit Programme' : 'Add Programme';

  const body = document.getElementById('programmeFormBody');
  if(body){
    body.innerHTML = `
      ${!prog ? `
      <div class="field" style="margin-bottom:14px;">
        <label>Faculty <span class="req">*</span></label>
        <select class="select" id="programmeFacultySelect">
          ${FACULTIES.map(f => `<option value="${f.key}" ${f.key===defaultFacultyKey?'selected':''}>${f.name}</option>`).join('')}
        </select>
      </div>` : `
      <div class="info-box" style="margin-bottom:14px;">
        <div class="k">Faculty</div>
        <div class="v" style="font-size:13px;">${facultyName(prog.facultyKey)}</div>
      </div>`}
      <div class="field">
        <label>Programme Name <span class="req">*</span></label>
        <input class="input" id="programmeNameInput" value="${prog ? prog.name : ''}" placeholder="e.g. Architecture" />
      </div>
      ${!prog ? `
      <div class="field" style="margin-top:14px;">
        <label>Registration Code Prefix</label>
        <input class="input" id="programmeCodeInput" placeholder="e.g. ARF (auto-filled if left blank)" maxlength="4" style="text-transform:uppercase;" />
      </div>` : ''}
      <div class="btn-row" style="margin-top:16px;">
        <button type="button" class="btn btn-ghost" onclick="closeSheet('programmeFormSheet')">Cancel</button>
        <button type="button" class="btn btn-primary" onclick="submitProgrammeForm(${prog ? `'${prog.key}'` : 'null'})">${ICONS.check} ${prog ? 'Save' : 'Add Programme'}</button>
      </div>
    `;
  }
  openSheet('programmeFormSheet');
}

function submitProgrammeForm(programmeKey){
  const name = document.getElementById('programmeNameInput')?.value.trim();
  if(!name){
    showToast("Enter a programme name");
    return;
  }
  let result;
  if(programmeKey){
    result = renameProgramme(programmeKey, name);
  } else {
    const facultyKey = document.getElementById('programmeFacultySelect')?.value;
    const codePrefix = document.getElementById('programmeCodeInput')?.value.trim();
    result = createProgramme(facultyKey, name, codePrefix);
  }
  if(result.error){
    showToast(result.error);
    return;
  }
  closeSheet('programmeFormSheet');
  showToast(programmeKey ? `Programme renamed to ${name}` : `${name} added`);
  navigate('facultiesProgrammes', { replace: true });
}

function confirmDeleteProgramme(programmeKey){
  const prog = PROGRAMMES.find(p => p.key === programmeKey);
  if(!prog) return;
  const result = deleteProgramme(programmeKey);
  if(result.error){
    showToast(result.error);
    return;
  }
  showToast(`${prog.name} deleted`);
  navigate('facultiesProgrammes', { replace: true });
}

// ============================================================
// ADMINISTRATOR: COURSE CATALOG
// ============================================================

function renderCourseCatalog(){
  const fk = currentRegistrarFacultyKey();
  const courses = scopedCourses();
  const programmeOptions = fk ? PROGRAMMES.filter(p => p.facultyKey === fk) : PROGRAMMES;
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('dashboard')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">${fk ? facultyName(fk).replace('Faculty of ','') + ' Courses' : 'Courses'}</div>
    </div>
  </div>
  <div class="content" style="padding-bottom:90px;">
    <div class="search-wrap">
      ${ICONS.search}
      <input class="input" placeholder="Search by code or name..." oninput="filterCourseCatalog()" id="courseSearch" />
    </div>
    <div class="field">
      <select class="select" id="courseProgrammeFilter" onchange="filterCourseCatalog()">
        <option value="">All Programmes</option>
        ${programmeOptions.map(p => `<option value="${p.key}">${p.name}</option>`).join('')}
      </select>
    </div>

    <div class="card card-pad">
      <div class="section-head-row">
        <div class="section-title" style="margin-bottom:0;">${ICONS.book} Course Catalog</div>
        <span style="font-size:11px;color:var(--ink-faint);font-weight:600;">${courses.length} courses</span>
      </div>
      <div id="courseList" style="display:flex; flex-direction:column; gap:10px;">
        ${courses.map(c => courseRow(c)).join('')}
      </div>
    </div>
  </div>
  <div class="sticky-footer">
    <div class="sticky-footer-inner" style="padding:8px;">
      <button class="btn btn-primary" onclick="openCourseFormSheet()">${ICONS.plus} Add Course</button>
    </div>
  </div>

  <div class="sheet" id="courseFormSheet">
    <div class="sheet-handle"></div>
    <div class="sheet-title">
      <span id="courseFormTitle">Add Course</span>
      <button onclick="closeSheet('courseFormSheet')">${ICONS.close}</button>
    </div>
    <div id="courseFormBody"></div>
  </div>`;
}

function courseRow(c){
  return `
  <div class="lecture-row" data-course-card data-code="${c.code.toLowerCase()}" data-name="${c.name.toLowerCase()}" data-programme="${c.programmeKey||''}">
    <div style="flex:1; min-width:0;">
      <div class="lecture-code" style="font-size:13px;">${c.code} — ${c.name}</div>
      <div class="lecture-meta" style="margin-top:4px;">${c.programme || 'No programme'}${c.lecturer ? ' · ' + c.lecturer : ''}${c.mode ? ' · ' + (c.mode==='day'?'Day':'Evening') : ''}</div>
    </div>
    <div style="display:flex; gap:6px; flex-shrink:0;">
      <button class="icon-btn" style="width:30px;height:30px;background:var(--unmarked-bg);" onclick="openCourseFormSheet('${c.code}')" title="Edit">${ICONS.edit.replace(/<svg /,'<svg style="width:13px;height:13px;" ')}</button>
      <button class="icon-btn" style="width:30px;height:30px;background:#fee2e2;color:#b91c1c;" onclick="confirmDeleteCourse('${c.code}')" title="Delete">${ICONS.close.replace(/<svg /,'<svg style="width:13px;height:13px;" ')}</button>
    </div>
  </div>`;
}

function filterCourseCatalog(){
  const q = (document.getElementById('courseSearch')?.value || '').toLowerCase();
  const prog = document.getElementById('courseProgrammeFilter')?.value || '';
  let visibleCount = 0;
  document.querySelectorAll('[data-course-card]').forEach(row => {
    const textMatch = !q || row.dataset.code.includes(q) || row.dataset.name.includes(q);
    const progMatch = !prog || row.dataset.programme === prog;
    const visible = textMatch && progMatch;
    row.style.display = visible ? 'flex' : 'none';
    if(visible) visibleCount++;
  });
  toggleNoResultsState('courseList', visibleCount, 'Try a different search or programme filter');
}

function openCourseFormSheet(code){
  const course = code ? COURSES.find(c => c.code === code) : null;
  const title = document.getElementById('courseFormTitle');
  if(title) title.textContent = course ? 'Edit Course' : 'Add Course';

  const body = document.getElementById('courseFormBody');
  if(body){
    body.innerHTML = `
      <div class="field" style="margin-bottom:14px;">
        <label>Course Code <span class="req">*</span></label>
        <input class="input" id="courseCodeInput" value="${course ? course.code : ''}" placeholder="e.g. CSC3106" style="text-transform:uppercase;" />
        ${course ? `<div class="s" style="margin-top:4px;">Changing this updates every timetable slot, record, and appeal that references ${course.code}.</div>` : ''}
      </div>
      <div class="field" style="margin-bottom:14px;">
        <label>Course Name <span class="req">*</span></label>
        <input class="input" id="courseNameInput" value="${course ? course.name : ''}" placeholder="e.g. Mobile App Development" />
      </div>
      <div class="field" style="margin-bottom:14px;">
        <label>Programme</label>
        <select class="select" id="courseProgrammeInput">
          <option value="">No programme</option>
          ${(currentRegistrarFacultyKey() ? PROGRAMMES.filter(p=>p.facultyKey===currentRegistrarFacultyKey()) : PROGRAMMES).map(p => `<option value="${p.key}" ${course && course.programmeKey===p.key ? 'selected':''}>${p.name}</option>`).join('')}
        </select>
      </div>
      <div class="field" style="margin-bottom:14px;">
        <label>Lecturer</label>
        <input class="input" id="courseLecturerInput" value="${course && course.lecturer ? course.lecturer : ''}" placeholder="e.g. Dr. Patrick Mukasa" />
      </div>
      <div class="field" style="margin-bottom:14px;">
        <label>Room</label>
        <input class="input" id="courseRoomInput" value="${course && course.room ? course.room : ''}" placeholder="e.g. LT1 - Main Building" />
      </div>
      <div class="field">
        <label>Mode</label>
        <select class="select" id="courseModeInput">
          <option value="" ${!course || !course.mode ? 'selected' : ''}>No restriction</option>
          <option value="day" ${course && course.mode==='day' ? 'selected' : ''}>Day</option>
          <option value="evening" ${course && course.mode==='evening' ? 'selected' : ''}>Evening</option>
        </select>
      </div>
      <div class="btn-row" style="margin-top:16px;">
        <button type="button" class="btn btn-ghost" onclick="closeSheet('courseFormSheet')">Cancel</button>
        <button type="button" class="btn btn-primary" onclick="submitCourseForm(${course ? `'${course.code}'` : 'null'})">${ICONS.check} ${course ? 'Save' : 'Add Course'}</button>
      </div>
    `;
  }
  openSheet('courseFormSheet');
}

function submitCourseForm(existingCode){
  const name = document.getElementById('courseNameInput')?.value.trim();
  const programmeKey = document.getElementById('courseProgrammeInput')?.value || null;
  const lecturer = document.getElementById('courseLecturerInput')?.value.trim();
  const room = document.getElementById('courseRoomInput')?.value.trim();
  const mode = document.getElementById('courseModeInput')?.value || null; // '' -> null ("no restriction")
  const prog = PROGRAMMES.find(p => p.key === programmeKey);

  // Belt-and-suspenders: the Programme <select> is already restricted to the
  // Registrar's own faculty in the form itself, but its value is still
  // readable/forgeable via JS, so this is the real enforcement point.
  const fk = currentRegistrarFacultyKey();
  if(fk && prog && prog.facultyKey !== fk){
    showToast("You can only manage courses in your own faculty");
    return;
  }
  if(fk && !existingCode && !prog){
    showToast("Select a programme in your faculty");
    return;
  }

  let result;
  if(existingCode){
    const newCode = document.getElementById('courseCodeInput')?.value.trim().toUpperCase();
    if(!newCode){
      showToast("Course code can't be empty");
      return;
    }
    if(newCode !== existingCode && COURSES.find(c => c.code === newCode)){
      showToast(`${newCode} is already in use by another course`);
      return;
    }
    let touched = 0;
    if(newCode !== existingCode){
      touched = cascadeRenameCourseCode(existingCode, newCode);
    }
    result = editCourse(existingCode, { code: newCode, name, programmeKey, programme: prog ? prog.name : null, lecturer: lecturer || null, room: room || null, mode: mode || null });
    if(!result.error && touched > 0){
      showToast(`${existingCode} renamed to ${newCode} — updated ${touched} reference${touched===1?'':'s'} across the app`);
      closeSheet('courseFormSheet');
      navigate('courseCatalog', { replace: true });
      return;
    }
  } else {
    const code = document.getElementById('courseCodeInput')?.value.trim();
    if(!name){
      showToast("Enter a course name");
      return;
    }
    result = createCourse(code, name, programmeKey, lecturer, room, mode);
  }
  if(result.error){
    showToast(result.error);
    return;
  }
  closeSheet('courseFormSheet');
  showToast(existingCode ? `${existingCode} updated` : `${result.code} added to the catalog`);
  navigate('courseCatalog', { replace: true });
}

function confirmDeleteCourse(code){
  const fk = currentRegistrarFacultyKey();
  if(fk){
    const course = COURSES.find(c => c.code === code);
    const prog = course && PROGRAMMES.find(p => p.key === course.programmeKey);
    if(!prog || prog.facultyKey !== fk){
      showToast("You can only manage courses in your own faculty");
      return;
    }
  }
  const result = deleteCourse(code);
  if(result.error){
    showToast(result.error);
    return;
  }
  showToast(`${code} deleted`);
  navigate('courseCatalog', { replace: true });
}

// ============================================================
// ADMINISTRATOR: ATTENDANCE POLICIES
// ============================================================

function renderAttendancePolicies(){
  const p = ATTENDANCE_POLICIES;
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('dashboard')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Attendance Policies</div>
    </div>
  </div>
  <div class="content">
    <div class="empty-state-sm" style="background:var(--unmarked-bg); border-radius:var(--radius-md); padding:14px; text-align:left; color:var(--ink-soft); font-size:12px; line-height:1.5; font-weight:500;">
      ${ICONS.gavel.replace(/<svg /,'<svg style="width:14px;height:14px;vertical-align:-2px;" ')} Changes take effect immediately — new sessions pick up QR and window settings the next time a session starts.
    </div>

    <div class="card card-pad" style="margin-top:14px;">
      <div class="section-title">${ICONS.users} Attendance Thresholds</div>

      <div class="field">
        <label>Minimum Attendance Percentage</label>
        <div style="font-size:11px;color:var(--ink-faint);margin-bottom:8px;">Students below this are flagged as "at risk" in all views and reports</div>
        <div style="display:flex; align-items:center; gap:12px;">
          <input class="input" type="number" id="policyMinPct" value="${p.minAttendancePct}" min="1" max="100" style="max-width:90px;" />
          <span style="font-size:14px; font-weight:700; color:var(--ink-soft);">%</span>
        </div>
      </div>

      <div class="field" style="margin-top:16px;">
        <label>Late Grace Period</label>
        <div style="font-size:11px;color:var(--ink-faint);margin-bottom:8px;">Minutes after session start that are still counted as "late" rather than absent</div>
        <div style="display:flex; align-items:center; gap:12px;">
          <input class="input" type="number" id="policyLateGrace" value="${p.lateGraceMinutes}" min="0" max="60" style="max-width:90px;" />
          <span style="font-size:14px; font-weight:700; color:var(--ink-soft);">minutes</span>
        </div>
      </div>
    </div>

    <div class="card card-pad">
      <div class="section-title">${ICONS.qrcode} QR & Session Settings</div>

      <div class="field">
        <label>QR Code Rotation Interval</label>
        <div style="font-size:11px;color:var(--ink-faint);margin-bottom:8px;">How often the QR code regenerates — shorter = harder to screenshot-share</div>
        <div style="display:flex; align-items:center; gap:12px;">
          <input class="input" type="number" id="policyQrRotate" value="${p.qrRotateSeconds}" min="10" max="300" style="max-width:90px;" />
          <span style="font-size:14px; font-weight:700; color:var(--ink-soft);">seconds</span>
        </div>
      </div>

      <div class="field" style="margin-top:16px;">
        <label>Session Window</label>
        <div style="font-size:11px;color:var(--ink-faint);margin-bottom:8px;">How long a check-in session stays open after the lecturer starts it</div>
        <div style="display:flex; align-items:center; gap:12px;">
          <input class="input" type="number" id="policySessionWindow" value="${p.sessionWindowMinutes}" min="1" max="60" style="max-width:90px;" />
          <span style="font-size:14px; font-weight:700; color:var(--ink-soft);">minutes</span>
        </div>
      </div>
    </div>

    <button class="btn btn-primary" onclick="saveAttendancePolicies()">${ICONS.check} Save Policies</button>
  </div>`;
}

function saveAttendancePolicies(){
  const minPct = parseInt(document.getElementById('policyMinPct')?.value || '75', 10);
  const lateGrace = parseInt(document.getElementById('policyLateGrace')?.value || '10', 10);
  const qrRotate = parseInt(document.getElementById('policyQrRotate')?.value || '30', 10);
  const sessionWindow = parseInt(document.getElementById('policySessionWindow')?.value || '10', 10);

  if(minPct < 1 || minPct > 100){ showToast("Minimum attendance must be 1–100%"); return; }
  if(lateGrace < 0 || lateGrace > 60){ showToast("Late grace must be 0–60 minutes"); return; }
  if(qrRotate < 10 || qrRotate > 300){ showToast("QR rotation must be 10–300 seconds"); return; }
  if(sessionWindow < 1 || sessionWindow > 60){ showToast("Session window must be 1–60 minutes"); return; }

  ATTENDANCE_POLICIES.minAttendancePct = minPct;
  ATTENDANCE_POLICIES.lateGraceMinutes = lateGrace;
  ATTENDANCE_POLICIES.qrRotateSeconds = qrRotate;
  ATTENDANCE_POLICIES.sessionWindowMinutes = sessionWindow;
  logAuditEvent(State.user?.staffId||'system', State.user?.name||'System', 'Policy updated', 'policies', `minPct=${minPct}%, grace=${lateGrace}min, qrRotate=${qrRotate}s, window=${sessionWindow}min`);

  showToast("Attendance policies saved");
  // Stay on the screen — re-render in place so inputs reflect the saved values cleanly.
  navigate('attendancePolicies', { replace: true });
}

// ============================================================
// ADMINISTRATOR: FRAUD THRESHOLDS
// ============================================================

function renderFraudThresholds(){
  const ft = FRAUD_THRESHOLDS;
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('dashboard')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Fraud Thresholds</div>
    </div>
  </div>
  <div class="content">
    <div class="empty-state-sm" style="background:var(--unmarked-bg); border-radius:var(--radius-md); padding:14px; text-align:left; color:var(--ink-soft); font-size:12px; line-height:1.5; font-weight:500;">
      ${ICONS.flag.replace(/<svg /,'<svg style="width:14px;height:14px;vertical-align:-2px;" ')} Detection thresholds control what triggers a fraud flag in the Fraud Center. Changes take effect immediately on new check-in events.
    </div>

    <div class="card card-pad" style="margin-top:14px;">
      <div class="section-title">${ICONS.flag} Device & Timing Rules</div>

      <div class="field">
        <label>Shared Device Window</label>
        <div style="font-size:11px;color:var(--ink-faint);margin-bottom:8px;">Flag if the same device checks in more than one student within this window</div>
        <div style="display:flex;align-items:center;gap:12px;">
          <input class="input" type="number" id="ftSharedWindow" value="${ft.sharedDeviceWindowMinutes}" min="1" max="60" style="max-width:90px;" />
          <span style="font-size:14px;font-weight:700;color:var(--ink-soft);">minutes</span>
        </div>
      </div>

      <div class="field" style="margin-top:16px;">
        <label>Max Check-ins Per Device Per Session</label>
        <div style="font-size:11px;color:var(--ink-faint);margin-bottom:8px;">Flag if a single device registers more than this many unique students in one session</div>
        <div style="display:flex;align-items:center;gap:12px;">
          <input class="input" type="number" id="ftMaxCheckins" value="${ft.maxCheckInsPerDevice}" min="1" max="10" style="max-width:90px;" />
          <span style="font-size:14px;font-weight:700;color:var(--ink-soft);">students</span>
        </div>
      </div>
    </div>

    <div class="card card-pad">
      <div class="section-title">${ICONS.shield} Detection Rules</div>

      <div class="lecture-row" style="padding:12px 0; flex-direction:column; gap:6px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:13px;font-weight:700;">Device Fingerprint Check</div>
            <div style="font-size:11px;color:var(--ink-faint);">Flag when check-in device doesn't match enrollment record</div>
          </div>
          <label class="toggle-wrap">
            <input type="checkbox" id="ftFingerprintCheck" ${ft.deviceFingerprintCheck?'checked':''} onchange="saveFraudThresholds()" />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <div class="lecture-row" style="padding:12px 0; flex-direction:column; gap:6px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:13px;font-weight:700;">Auto-escalate High Severity</div>
            <div style="font-size:11px;color:var(--ink-faint);">Automatically notify Registrar when a high-severity flag is raised</div>
          </div>
          <label class="toggle-wrap">
            <input type="checkbox" id="ftAutoEscalate" ${ft.autoEscalateHighSeverity?'checked':''} onchange="saveFraudThresholds()" />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <div class="lecture-row" style="padding:12px 0; flex-direction:column; gap:6px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:13px;font-weight:700;">Flag VPN Check-ins</div>
            <div style="font-size:11px;color:var(--ink-faint);">Flag check-ins from known VPN ranges (may produce false positives)</div>
          </div>
          <label class="toggle-wrap">
            <input type="checkbox" id="ftFlagVPN" ${ft.flagOnVPN?'checked':''} onchange="saveFraudThresholds()" />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
    </div>

    <button class="btn btn-primary" onclick="saveFraudThresholds()">${ICONS.check} Save Thresholds</button>
  </div>`;
}

function saveFraudThresholds(){
  const win = parseInt(document.getElementById('ftSharedWindow')?.value||'4', 10);
  const max = parseInt(document.getElementById('ftMaxCheckins')?.value||'1', 10);
  if(win < 1 || win > 60){ showToast("Window must be 1–60 minutes"); return; }
  if(max < 1 || max > 10){ showToast("Max must be 1–10 students"); return; }
  FRAUD_THRESHOLDS.sharedDeviceWindowMinutes = win;
  FRAUD_THRESHOLDS.maxCheckInsPerDevice = max;
  FRAUD_THRESHOLDS.deviceFingerprintCheck = document.getElementById('ftFingerprintCheck')?.checked ?? FRAUD_THRESHOLDS.deviceFingerprintCheck;
  FRAUD_THRESHOLDS.autoEscalateHighSeverity = document.getElementById('ftAutoEscalate')?.checked ?? FRAUD_THRESHOLDS.autoEscalateHighSeverity;
  FRAUD_THRESHOLDS.flagOnVPN = document.getElementById('ftFlagVPN')?.checked ?? FRAUD_THRESHOLDS.flagOnVPN;
  logAuditEvent(State.user?.staffId||'system', State.user?.name||'System', 'Fraud thresholds updated', 'fraud', `window=${win}min, maxPerDevice=${max}`);
  showToast("Fraud thresholds saved");
  navigate('fraudThresholds', { replace: true });
}

// ============================================================
// ADMINISTRATOR: NOTIFICATION TEMPLATES
// ============================================================

function renderNotifTemplates(){
  const templates = Object.entries(NOTIFICATION_TEMPLATES);
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('dashboard')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Notification Templates</div>
    </div>
  </div>
  <div class="content">
    <div class="empty-state-sm" style="background:var(--unmarked-bg); border-radius:var(--radius-md); padding:14px; text-align:left; color:var(--ink-soft); font-size:12px; line-height:1.5; font-weight:500;">
      ${ICONS.megaphone.replace(/<svg /,'<svg style="width:14px;height:14px;vertical-align:-2px;" ')} Edit the messages VUSAP sends for each event. Use <code style="background:rgba(0,0,0,.06);padding:1px 4px;border-radius:4px;">{tokens}</code> to insert dynamic values.
    </div>
    ${templates.map(([key, t]) => notifTemplateCard(key, t)).join('')}
  </div>

  <div class="sheet" id="notifEditSheet">
    <div class="sheet-handle"></div>
    <div class="sheet-title">
      <span id="notifEditTitle">Edit Template</span>
      <button onclick="closeSheet('notifEditSheet')">${ICONS.close}</button>
    </div>
    <div id="notifEditBody"></div>
  </div>`;
}

function notifTemplateCard(key, t){
  return `
  <div class="card card-pad" style="margin-top:12px;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
      <div style="flex:1;">
        <div style="font-weight:800;font-size:13px;">${t.label}</div>
        <div style="font-size:11.5px;color:var(--ink-faint);margin-top:2px;">${t.description}</div>
        <div style="font-size:11.5px;color:var(--ink-soft);margin-top:6px;font-style:italic;">"${t.subject}"</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-shrink:0;">
        <label class="toggle-wrap" style="margin:0;">
          <input type="checkbox" ${t.enabled?'checked':''} onchange="toggleNotifTemplate('${key}',this.checked)" />
          <span class="toggle-slider"></span>
        </label>
        <button class="icon-btn" style="width:32px;height:32px;background:var(--unmarked-bg);" onclick="openNotifEditSheet('${key}')">${ICONS.edit.replace(/<svg /,'<svg style="width:13px;height:13px;" ')}</button>
      </div>
    </div>
  </div>`;
}

function toggleNotifTemplate(key, enabled){
  if(NOTIFICATION_TEMPLATES[key]) NOTIFICATION_TEMPLATES[key].enabled = enabled;
  showToast(`${NOTIFICATION_TEMPLATES[key]?.label} ${enabled?'enabled':'disabled'}`);
}

function openNotifEditSheet(key){
  const t = NOTIFICATION_TEMPLATES[key];
  if(!t) return;
  const title = document.getElementById('notifEditTitle');
  if(title) title.textContent = `Edit — ${t.label}`;
  const body = document.getElementById('notifEditBody');
  if(body){
    body.innerHTML = `
      <div class="field" style="margin-bottom:14px;">
        <label>Subject</label>
        <input class="input" id="notifSubject" value="${t.subject.replace(/"/g,'&quot;')}" />
      </div>
      <div class="field">
        <label>Body</label>
        <textarea class="input" id="notifBody" rows="8" style="height:auto;resize:vertical;">${t.body}</textarea>
      </div>
      <div class="info-box" style="margin-top:12px;">
        <div class="k">Available tokens for this template</div>
        <div class="v" style="font-size:12px;font-family:monospace;color:var(--ink-soft);">${getTemplateTokens(key).join(' &nbsp; ')}</div>
      </div>
      <div class="btn-row" style="margin-top:16px;">
        <button type="button" class="btn btn-ghost" onclick="closeSheet('notifEditSheet')">Cancel</button>
        <button type="button" class="btn btn-primary" onclick="saveNotifTemplate('${key}')">${ICONS.check} Save</button>
      </div>
    `;
  }
  openSheet('notifEditSheet');
}

function getTemplateTokens(key){
  const tokens = {
    lowAttendanceWarning: ['{studentName}','{courseName}','{attendancePct}','{minPct}'],
    sessionStarted: ['{studentName}','{lecturerName}','{courseName}','{windowMinutes}'],
    appealResolved: ['{studentName}','{courseName}','{sessionDate}','{resolution}','{resolutionNote}'],
    accountProvisioned: ['{name}','{userId}','{tempPassword}'],
    fraudFlagged: ['{studentName}','{courseName}','{reason}','{date}'],
  };
  return tokens[key] || [];
}

function saveNotifTemplate(key){
  const t = NOTIFICATION_TEMPLATES[key];
  if(!t) return;
  t.subject = document.getElementById('notifSubject')?.value || t.subject;
  t.body = document.getElementById('notifBody')?.value || t.body;
  closeSheet('notifEditSheet');
  logAuditEvent(State.user?.staffId||'system', State.user?.name||'System', 'Notification template updated', key, t.label);
  showToast(`${t.label} saved`);
  navigate('notifTemplates', { replace: true });
}

// ============================================================
// ADMINISTRATOR: SYSTEM SETTINGS
// ============================================================

function renderSystemSettings(){
  const s = SYSTEM_SETTINGS;
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('dashboard')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">System Settings</div>
    </div>
  </div>
  <div class="content">
    <div class="card card-pad">
      <div class="section-title">${ICONS.settings} General</div>

      <div class="field">
        <label>System Name</label>
        <input class="input" id="ssSystemName" value="${s.systemName}" />
      </div>
      <div class="field" style="margin-top:14px;">
        <label>Institution Name</label>
        <input class="input" id="ssInstitutionName" value="${s.institutionName}" />
      </div>
      <div class="field" style="margin-top:14px;">
        <label>Support Email</label>
        <input class="input" type="email" id="ssSupportEmail" value="${s.supportEmail}" />
      </div>
      <div class="field" style="margin-top:14px;">
        <label>Academic Year</label>
        <input class="input" id="ssAcademicYear" value="${s.academicYear}" placeholder="e.g. 2025/2026" />
      </div>
    </div>

    <div class="card card-pad">
      <div class="section-title">${ICONS.shield} Access & Security</div>

      <div class="field">
        <label>Auto-logout After Inactivity</label>
        <div style="font-size:11px;color:var(--ink-faint);margin-bottom:8px;">Sessions end automatically after this many minutes of inactivity</div>
        <div style="display:flex;align-items:center;gap:12px;">
          <input class="input" type="number" id="ssAutoLogout" value="${s.autoLogoutMinutes}" min="5" max="480" style="max-width:90px;" />
          <span style="font-size:14px;font-weight:700;color:var(--ink-soft);">minutes</span>
        </div>
      </div>

      <div class="lecture-row" style="padding:12px 0;">
        <div style="flex:1;">
          <div style="font-size:13px;font-weight:700;">Require Email Verification</div>
          <div style="font-size:11px;color:var(--ink-faint);">New accounts must verify their email before first login</div>
        </div>
        <label class="toggle-wrap">
          <input type="checkbox" id="ssEmailVerif" ${s.requireEmailVerification?'checked':''} />
          <span class="toggle-slider"></span>
        </label>
      </div>

      <div class="lecture-row" style="padding:12px 0;">
        <div style="flex:1;">
          <div style="font-size:13px;font-weight:700;">Allow Student Self-enrollment</div>
          <div style="font-size:11px;color:var(--ink-faint);">Students can enroll themselves without a Registrar (not recommended)</div>
        </div>
        <label class="toggle-wrap">
          <input type="checkbox" id="ssSelfEnroll" ${s.allowSelfEnrollment?'checked':''} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <div class="card card-pad" style="border:1px solid var(--late);">
      <div class="section-title" style="color:var(--late);">${ICONS.flag} Maintenance Mode</div>
      <div style="font-size:12px;color:var(--ink-soft);margin-bottom:14px;line-height:1.5;">
        When enabled, only the Principal (Administrator) can log in. All other users see a maintenance notice. Use during upgrades or data corrections.
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-size:13px;font-weight:700;color:${s.maintenanceMode?'var(--late)':'var(--ink-soft)'};">${s.maintenanceMode?'Maintenance Mode is ON':'Maintenance Mode is off'}</div>
        </div>
        <label class="toggle-wrap">
          <input type="checkbox" id="ssMaintenanceMode" ${s.maintenanceMode?'checked':''} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <button class="btn btn-primary" onclick="saveSystemSettings()">${ICONS.check} Save Settings</button>
  </div>`;
}

function saveSystemSettings(){
  const autoLogout = parseInt(document.getElementById('ssAutoLogout')?.value||'30', 10);
  if(autoLogout < 5 || autoLogout > 480){ showToast("Auto-logout must be 5–480 minutes"); return; }

  SYSTEM_SETTINGS.systemName = document.getElementById('ssSystemName')?.value.trim() || SYSTEM_SETTINGS.systemName;
  SYSTEM_SETTINGS.institutionName = document.getElementById('ssInstitutionName')?.value.trim() || SYSTEM_SETTINGS.institutionName;
  SYSTEM_SETTINGS.supportEmail = document.getElementById('ssSupportEmail')?.value.trim() || SYSTEM_SETTINGS.supportEmail;
  SYSTEM_SETTINGS.academicYear = document.getElementById('ssAcademicYear')?.value.trim() || SYSTEM_SETTINGS.academicYear;
  SYSTEM_SETTINGS.autoLogoutMinutes = autoLogout;
  SYSTEM_SETTINGS.requireEmailVerification = document.getElementById('ssEmailVerif')?.checked ?? SYSTEM_SETTINGS.requireEmailVerification;
  SYSTEM_SETTINGS.allowSelfEnrollment = document.getElementById('ssSelfEnroll')?.checked ?? SYSTEM_SETTINGS.allowSelfEnrollment;

  const prevMaintenance = SYSTEM_SETTINGS.maintenanceMode;
  SYSTEM_SETTINGS.maintenanceMode = document.getElementById('ssMaintenanceMode')?.checked ?? SYSTEM_SETTINGS.maintenanceMode;
  if(SYSTEM_SETTINGS.maintenanceMode !== prevMaintenance){
    logAuditEvent(State.user?.staffId||'system', State.user?.name||'System', SYSTEM_SETTINGS.maintenanceMode ? 'Maintenance mode enabled' : 'Maintenance mode disabled', 'system', '');
  }
  logAuditEvent(State.user?.staffId||'system', State.user?.name||'System', 'System settings updated', 'system', `autoLogout=${autoLogout}min`);
  showToast("System settings saved");
  navigate('systemSettings', { replace: true });
}

// ============================================================
// ADMINISTRATOR: AUDIT SYSTEM
// ============================================================

// ============================================================
// SHARED: NOTIFICATIONS INBOX
// ============================================================

let inboxSortMode = 'newest';

function setInboxSort(mode){
  inboxSortMode = mode;
  refreshScreenContentOnly();
}

function sortNotifications(list, mode){
  const arr = [...list];
  const t = n => new Date(n.createdAt || n.date).getTime() || 0;
  switch(mode){
    case 'oldest':
      return arr.sort((a,b) => t(a) - t(b));
    case 'course':
      // Course-scoped items grouped together (alphabetically by code),
      // newest first within each group; items with no course go last.
      return arr.sort((a,b) => {
        const ac = a.courseCode || 'zzzz', bc = b.courseCode || 'zzzz';
        return ac.localeCompare(bc) || (t(b) - t(a));
      });
    case 'unread':
      return arr.sort((a,b) => (a.read === b.read ? 0 : a.read ? 1 : -1) || (t(b) - t(a)));
    case 'newest':
    default:
      return arr.sort((a,b) => t(b) - t(a));
  }
}

function renderNotifications(){
  const notifs = sortNotifications(notificationsForCurrentUser(), inboxSortMode);
  const backTarget = State.role === 'student' ? 'home' : 'dashboard';
  // Snapshot which items are unread BEFORE marking them read — markAllNotifsRead()
  // mutates these same objects in place, and since it previously ran before this
  // function's return statement was evaluated, every item always looked already
  // read by the time the HTML was built (a pre-existing bug: "unread" styling
  // was never actually visible). This snapshot is what "was unread when this
  // inbox was opened" actually means, and is what should drive the bold/dot
  // styling below — not the live (now-mutated) n.read value.
  const wasUnread = new Set(notifs.filter(n => !n.read).map(n => n.id));
  markAllNotifsRead();
  // Re-render the bell badge after marking all read
  setTimeout(() => {
    document.querySelectorAll('.notif-badge').forEach(b => b.remove());
  }, 50);

  const typeIcon = {
    lowAttendanceWarning: ICONS.flag,
    sessionStarted: ICONS.qrcode,
    appealResolved: ICONS.check,
    fraudFlagged: ICONS.flag,
    accountProvisioned: ICONS.users,
    general: ICONS.bell,
    announcement: ICONS.megaphone,
  };
  const typeColor = {
    lowAttendanceWarning: 'var(--absent)',
    sessionStarted: 'var(--present)',
    appealResolved: 'var(--present)',
    fraudFlagged: 'var(--absent)',
    accountProvisioned: 'var(--theme-primary)',
    general: 'var(--theme-primary)',
    announcement: '#b45309',
  };

  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('${backTarget}')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Inbox</div>
    </div>
  </div>
  <div class="content">
    ${notifs.length === 0 ? `
      <div class="empty-state">
        ${ICONS.bell}
        <div class="t" style="margin-top:14px;">All caught up</div>
        <div class="s">No notifications yet</div>
      </div>
    ` : `
      <div class="field" style="margin-bottom:12px;">
        <label>Sort by</label>
        <select class="select" id="inboxSortSelect" onchange="setInboxSort(this.value)">
          <option value="newest" ${inboxSortMode==='newest'?'selected':''}>Newest first</option>
          <option value="oldest" ${inboxSortMode==='oldest'?'selected':''}>Oldest first</option>
          <option value="course" ${inboxSortMode==='course'?'selected':''}>By course</option>
          <option value="unread" ${inboxSortMode==='unread'?'selected':''}>Unread first</option>
        </select>
      </div>
      <div class="card card-pad">
        <div style="display:flex;flex-direction:column;gap:0;">
          ${notifs.map(n => {
            const color = typeColor[n.type] || 'var(--ink-soft)';
            const preview = n.body.length > 60 ? n.body.slice(0, 60) + '…' : n.body;
            const unread = wasUnread.has(n.id);
            return `
          <div class="notif-row" data-id="${n.id}" onclick="toggleNotifExpand('${n.id}')" style="cursor:pointer;align-items:flex-start;gap:12px;display:flex;${unread?'background:#eef2ff; background:color-mix(in srgb, var(--theme-primary) 10%, white);':''}border-radius:var(--radius-md);padding:12px;margin-bottom:6px;">
            <div style="width:36px;height:36px;border-radius:50%;background:${color}22;flex-shrink:0;display:flex;align-items:center;justify-content:center;">
              <div style="color:${color};display:flex;">${(typeIcon[n.type]||ICONS.bell).replace(/<svg /,'<svg style="width:16px;height:16px;" ')}</div>
            </div>
            <div style="flex:1;min-width:0;">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                ${unread ? `<span style="width:7px;height:7px;border-radius:50%;background:var(--theme-primary);flex-shrink:0;"></span>` : ''}
                <div style="font-size:13px;font-weight:${unread?'800':'500'};">${n.title}</div>
                ${n.type === 'announcement' ? `<span class="tag-mini" style="background:#fef3c7;color:#b45309;">Announcement</span>` : ''}
                ${n.courseCode ? `<span class="tag-mini">${n.courseCode}</span>` : ''}
              </div>
              <div class="notif-preview" id="notif-preview-${n.id}" style="font-size:11.5px;color:var(--ink-soft);margin-top:3px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:${unread?'600':'400'};">${preview}</div>
              <div class="notif-full" id="notif-full-${n.id}" style="display:none;font-size:11.5px;color:var(--ink-soft);margin-top:3px;line-height:1.4;">${n.body}</div>
              <div style="font-size:10.5px;color:var(--ink-faint);margin-top:4px;">${n.from ? `From ${n.from} · ` : ''}${formatNotifTimestamp(n)}</div>
            </div>
            <div id="notif-chevron-${n.id}" style="color:var(--ink-faint);flex-shrink:0;margin-top:2px;transition:transform .15s;">${ICONS.chevR}</div>
          </div>`;
          }).join('')}
        </div>
      </div>
    `}
  </div>`;
}

// Tap-to-expand: reveals the full message body inline (swapping out the
// truncated one-line preview) without navigating anywhere or re-rendering
// the whole screen — a plain DOM toggle scoped to just that row.
function toggleNotifExpand(id){
  const preview = document.getElementById('notif-preview-' + id);
  const full = document.getElementById('notif-full-' + id);
  const chevron = document.getElementById('notif-chevron-' + id);
  if(!preview || !full) return;
  const isExpanded = full.style.display !== 'none';
  full.style.display = isExpanded ? 'none' : 'block';
  preview.style.display = isExpanded ? '' : 'none';
  if(chevron) chevron.style.transform = isExpanded ? '' : 'rotate(90deg)';
}

function renderAuditSystem(){
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('dashboard')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Audit System</div>
    </div>
  </div>
  <div class="content">
    <div class="search-wrap">
      ${ICONS.search}
      <input class="input" placeholder="Search by actor, action, or detail..." oninput="filterAuditLog()" id="auditSearch" />
    </div>
    <div class="field">
      <select class="select" id="auditActionFilter" onchange="filterAuditLog()">
        <option value="">All Actions</option>
        <option value="Account">Account changes</option>
        <option value="Appeal">Appeals</option>
        <option value="Faculty">Faculty changes</option>
        <option value="Policy">Policy changes</option>
        <option value="Fraud">Fraud events</option>
        <option value="Session">Sessions</option>
        <option value="System">System</option>
      </select>
    </div>
    <div class="card card-pad">
      <div class="section-head-row">
        <div class="section-title" style="margin-bottom:0;">${ICONS.fileText} Audit Trail</div>
        <span style="font-size:11px;color:var(--ink-faint);font-weight:600;">${AUDIT_LOG.length} events</span>
      </div>
      <div id="auditList" style="display:flex;flex-direction:column;gap:0;">
        ${AUDIT_LOG.map(e => auditEventRow(e)).join('')}
      </div>
    </div>
  </div>`;
}

function auditEventRow(e){
  const severityColor = e.action.toLowerCase().includes('suspend') || e.action.toLowerCase().includes('delete') || e.action.toLowerCase().includes('maintenance') ? 'var(--absent)' :
    e.action.toLowerCase().includes('create') || e.action.toLowerCase().includes('approved') ? 'var(--present)' : 'var(--ink-soft)';
  return `
  <div class="student-card-row" data-audit-row data-text="${(e.actorName+' '+e.action+' '+e.detail).toLowerCase()}" data-action="${e.action}">
    <div style="flex:1;min-width:0;">
      <div style="font-size:12.5px;font-weight:700;color:${severityColor};">${e.action}</div>
      <div style="font-size:11.5px;color:var(--ink-soft);margin-top:2px;">${e.detail || e.target}</div>
      <div style="font-size:10.5px;color:var(--ink-faint);margin-top:3px;">${e.actorName} · ${e.timestamp}</div>
    </div>
  </div>`;
}

function filterAuditLog(){
  const q = (document.getElementById('auditSearch')?.value||'').toLowerCase();
  const actionFilter = document.getElementById('auditActionFilter')?.value||'';
  let count = 0;
  document.querySelectorAll('[data-audit-row]').forEach(row => {
    const textMatch = !q || row.dataset.text.includes(q);
    const actionMatch = !actionFilter || row.dataset.action.includes(actionFilter);
    const visible = textMatch && actionMatch;
    row.style.display = visible ? 'flex' : 'none';
    if(visible) count++;
  });
  toggleNoResultsState('auditList', count, 'No events match your filter');
}

// ============================================================
// ADMINISTRATOR: BACKUPS
// ============================================================
// This module acknowledges honestly that real backups require a backend
// (pg_dump/Supabase point-in-time recovery). The screen shows the UI Admin
// will eventually use, explains clearly what's deferred, and lets them
// export the current in-memory state as a JSON snapshot for demo purposes.
// ============================================================

function renderBackups(){
  const snapshots = [
    { label:'Auto-backup', timestamp:'2026-06-28 03:00', size:'4.2 MB', status:'complete' },
    { label:'Auto-backup', timestamp:'2026-06-27 03:00', size:'4.1 MB', status:'complete' },
    { label:'Manual snapshot', timestamp:'2026-06-26 14:32', size:'4.0 MB', status:'complete' },
    { label:'Auto-backup', timestamp:'2026-06-26 03:00', size:'4.0 MB', status:'complete' },
  ];
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('dashboard')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Backups</div>
    </div>
  </div>
  <div class="content">
    <div class="empty-state-sm" style="background:#fef3c7; border-radius:var(--radius-md); padding:14px; text-align:left; color:#92400e; font-size:12px; line-height:1.5; font-weight:500;">
      ${ICONS.archive.replace(/<svg /,'<svg style="width:14px;height:14px;vertical-align:-2px;" ')} <strong>Requires backend:</strong> Scheduled backups, restore, and retention policies need Supabase point-in-time recovery or a pg_dump pipeline (Gates 4–7). The list below is illustrative — restore is deferred until then.
    </div>

    <div class="card card-pad" style="margin-top:14px;">
      <div class="section-title">${ICONS.archive} Backup Schedule</div>

      <div class="lecture-row" style="flex-direction:column;gap:4px;padding:12px 0;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:13px;font-weight:700;">Automatic Daily Backup</div>
            <div style="font-size:11px;color:var(--ink-faint);">Runs at 03:00 UTC — retained for 30 days</div>
          </div>
          <span class="badge dept" style="background:#dcfce7;color:#16a34a;">Enabled</span>
        </div>
      </div>

      <div class="lecture-row" style="flex-direction:column;gap:4px;padding:12px 0;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:13px;font-weight:700;">Point-in-time Recovery</div>
            <div style="font-size:11px;color:var(--ink-faint);">Restore to any second in the last 7 days</div>
          </div>
          <span class="badge dept" style="background:#f1f5f9;color:#64748b;">Backend required</span>
        </div>
      </div>

      <button class="btn btn-ghost" style="margin-top:10px;" onclick="exportSnapshot()">${ICONS.fileText} Export Current State (JSON)</button>
    </div>

    <div class="card card-pad">
      <div class="section-title">${ICONS.clock} Recent Backups</div>
      ${snapshots.map(s => `
        <div class="lecture-row" style="padding:10px 0;">
          <div style="flex:1;">
            <div style="font-size:12.5px;font-weight:700;">${s.label}</div>
            <div class="lecture-meta">${s.timestamp} · ${s.size}</div>
          </div>
          <span class="badge dept" style="background:#dcfce7;color:#16a34a;">${s.status}</span>
        </div>`).join('')}
    </div>
  </div>`;
}

function exportSnapshot(){
  const snapshot = {
    exportedAt: new Date().toISOString(),
    exportedBy: State.user?.name,
    meta: { students: STUDENTS.length, faculties: FACULTIES.length, courses: COURSES.length },
    policies: ATTENDANCE_POLICIES,
    fraudThresholds: FRAUD_THRESHOLDS,
    systemSettings: SYSTEM_SETTINGS,
    auditLog: AUDIT_LOG.slice(0, 50),
  };
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vusap-snapshot-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  logAuditEvent(State.user?.staffId||'system', State.user?.name||'System', 'Snapshot exported', 'backup', 'JSON state export');
  showToast("Snapshot exported");
}

// ============================================================
// ADMINISTRATOR: DATABASE MANAGEMENT
// ============================================================
// Like Backups, real DDL/migrations need a real backend.
// This screen shows Admin a live read of the in-memory "database" shape,
// basic integrity checks, and honest deferral notes for operations that need
// Supabase (migrations, RLS policy management, index management).
// ============================================================

function renderDatabaseManagement(){
  const tables = [
    { name:'users', count:Object.keys(USERS).length, label:'Login accounts' },
    { name:'students', count:STUDENTS.length, label:'Student academic records' },
    { name:'faculties', count:FACULTIES.length, label:'Academic faculties' },
    { name:'programmes', count:PROGRAMMES.length, label:'Academic programmes' },
    { name:'courses', count:COURSES.length, label:'Course catalog entries' },
    { name:'attendance_records', count:RECORDS.length, label:'Attendance check-in records' },
    { name:'attendance_appeals', count:ATTENDANCE_APPEALS.length, label:'Student appeals' },
    { name:'suspicion_log', count:SUSPICION_LOG.length, label:'Fraud flag events' },
    { name:'audit_log', count:AUDIT_LOG.length, label:'Audit trail events' },
    { name:'lecturers', count:LECTURERS.length, label:'Lecturer directory entries' },
    { name:'registrars', count:REGISTRARS.length, label:'Registrar directory entries' },
  ];

  const integrityIssues = [];
  // Students without a valid faculty
  const badFaculty = STUDENTS.filter(s => !FACULTIES.find(f=>f.key===s.facultyKey)).length;
  if(badFaculty) integrityIssues.push(`${badFaculty} student(s) with invalid facultyKey`);
  // Registrars with no faculty seat
  const seatless = Object.values(USERS).filter(u=>u.role==='registrar' && !u.facultyKey).length;
  if(seatless) integrityIssues.push(`${seatless} registrar(s) with no faculty assigned`);
  // Accounts with no corresponding directory entry
  const staffRoles = ['lecturer','registrar','administrator'];
  const orphanAccounts = Object.entries(USERS).filter(([id,u]) => {
    if(!staffRoles.includes(u.role)) return false;
    if(u.role==='lecturer') return !LECTURERS.find(l=>l.id===id);
    if(u.role==='registrar') return !REGISTRARS.find(r=>r.id===id);
    if(u.role==='administrator') return !ADMINISTRATORS.find(a=>a.id===id);
  }).length;
  if(orphanAccounts) integrityIssues.push(`${orphanAccounts} account(s) with no directory entry`);

  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('dashboard')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Database</div>
    </div>
  </div>
  <div class="content">
    <div class="empty-state-sm" style="background:#fef3c7; border-radius:var(--radius-md); padding:14px; text-align:left; color:#92400e; font-size:12px; line-height:1.5; font-weight:500;">
      ${ICONS.database.replace(/<svg /,'<svg style="width:14px;height:14px;vertical-align:-2px;" ')} <strong>Read-only in this prototype.</strong> Migrations, RLS management, and index maintenance require Supabase direct access (Gates 4–7). Data counts and integrity checks below are live.
    </div>

    <div class="card card-pad" style="margin-top:14px;">
      <div class="section-head-row">
        <div class="section-title" style="margin-bottom:0;">${ICONS.database} In-memory Tables</div>
        <span style="font-size:11px;color:var(--ink-faint);font-weight:600;">${tables.reduce((a,t)=>a+t.count,0)} total rows</span>
      </div>
      ${tables.map(t => `
        <div class="lecture-row" style="padding:10px 0;">
          <div style="flex:1;">
            <div style="font-size:12.5px;font-weight:700;font-family:monospace;">${t.name}</div>
            <div class="lecture-meta">${t.label}</div>
          </div>
          <span style="font-size:14px;font-weight:800;color:var(--theme-primary);">${t.count.toLocaleString()}</span>
        </div>`).join('')}
    </div>

    <div class="card card-pad">
      <div class="section-title">${integrityIssues.length ? ICONS.flag : ICONS.check} Integrity Check</div>
      ${integrityIssues.length ? `
        ${integrityIssues.map(issue => `
          <div class="lecture-row" style="padding:10px 0;border-bottom:1px solid var(--line);">
            <div style="flex:1;font-size:12.5px;color:var(--absent);">${issue}</div>
          </div>`).join('')}
      ` : `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 0;color:var(--present);">
          ${ICONS.checkCircle.replace(/width="\d+" height="\d+"/,'width="20" height="20"')}
          <span style="font-size:13px;font-weight:700;">No integrity issues found</span>
        </div>
      `}
    </div>

    <div class="card card-pad">
      <div class="section-title">${ICONS.settings} Deferred Operations</div>
      ${['Run database migrations','Manage Row-Level Security policies','View query performance and slow logs','Manage indexes and table statistics','Vacuum and analyze tables'].map(op => `
        <div class="lecture-row" style="padding:10px 0;">
          <div style="flex:1;font-size:12.5px;color:var(--ink-soft);">${op}</div>
          <span class="badge dept" style="background:#f1f5f9;color:#64748b;">Backend required</span>
        </div>`).join('')}
    </div>
  </div>`;
}

// ============================================================
// STUDENT (CLASS COORDINATOR MODE): CLASS SUMMARY, MISSING LIST, CLASS REPORT
// ============================================================

function renderClassSummary(){
  const u = State.user;
  const classStudents = getCoordinatorClassStudents();
  const avgPct = classStudents.length
    ? Math.round(classStudents.reduce((s,st)=>s+(st.pct||0),0) / classStudents.length)
    : 0;
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('home')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Class Attendance Summary</div>
    </div>
  </div>
  <div class="content">
    <div class="coordinator-badge">${ICONS.shield.replace(/<svg /,'<svg style="width:12px;height:12px;" ')} ${u.coordinator_for_programme} · ${u.coordinator_for_year}</div>

    <div class="stat-grid">
      <div class="stat-tile">
        <div class="top"><span class="label">Class Size</span>
          <span class="stat-icon" style="background:#dbeafe; color:#1d4ed8;">${ICONS.users}</span></div>
        <div class="value">${classStudents.length}</div>
      </div>
      <div class="stat-tile">
        <div class="top"><span class="label">Avg. Attendance</span>
          <span class="stat-icon" style="background:#dcfce7; color:#16a34a;">${ICONS.trend}</span></div>
        <div class="value">${avgPct}%</div>
      </div>
    </div>

    <div class="card section-card">
      <div class="section-title">${ICONS.chart} Attendance Trend</div>
      ${donutChart([
        {label:'Present', value:classStudents.filter(s=>s.pct>=ATTENDANCE_POLICIES.minAttendancePct).length, color:'#16a34a'},
        {label:'At risk', value:classStudents.filter(s=>s.pct!==null && s.pct<ATTENDANCE_POLICIES.minAttendancePct).length, color:'#dc2626'},
        {label:'No data', value:classStudents.filter(s=>s.pct===null).length, color:'#94a3b8'},
      ])}
    </div>

    <div class="card card-pad">
      <div class="section-title">${ICONS.users} Class Roster</div>
      ${classStudents.map(s=>studentRegisterRow(s)).join('')}
    </div>
  </div>`;
}

function renderMissingStudents(){
  const classStudents = getCoordinatorClassStudents();
  const missing = classStudents.filter(s=>s.pct===null || s.pct<50);
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('home')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Missing Student List</div>
    </div>
  </div>
  <div class="content">
    <div class="info-box" style="background:#fef3c7; border-color:#fcd34d;">
      <div class="k" style="color:#92400e;">Today's session</div>
      <div class="v" style="color:#92400e; font-size:13px;">${LIVE_SESSION.courseName} · ${LIVE_SESSION.room}</div>
    </div>
    ${missing.length ? `
    <div class="card card-pad">
      <div class="section-title">${ICONS.alertTriangle} Not Checked In (${missing.length})</div>
      ${missing.map(s=>studentRegisterRow(s)).join('')}
    </div>` : `
    <div class="empty-state" style="padding:40px 20px;">
      ${ICONS.checkCircle}
      <div class="t" style="margin-top:14px;">Everyone's checked in</div>
      <div class="s">No missing students for the current session</div>
    </div>`}
  </div>`;
}

function renderClassReport(){
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('home')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Submit Class Report</div>
    </div>
  </div>
  <div class="content">
    <form onsubmit="return handleClassReportSubmit(event)" style="display:flex; flex-direction:column; gap:14px;">
      <div class="field">
        <label>Report Type <span class="req">*</span></label>
        <select class="select" id="reportType">
          <option value="lecturer_absence">Report Lecturer Absence</option>
          <option value="attendance_issue">Report Attendance Issue</option>
          <option value="general">General Class Report</option>
        </select>
      </div>
      <div class="field">
        <label>Course</label>
        <select class="select" id="reportCourseSelect">
          ${STUDENT_COURSES.map(c=>`<option value="${c.code}">${c.code} — ${c.name}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Details <span class="req">*</span></label>
        <textarea class="input" id="reportDetails" rows="5" placeholder="Describe what happened..." required style="resize:vertical;"></textarea>
      </div>
      <button class="btn btn-primary" type="submit">${ICONS.fileText} Submit Report</button>
    </form>
  </div>`;
}

function handleClassReportSubmit(e){
  e.preventDefault();
  showToast("Report submitted to the Registrar's Office");
  navigate('home');
  return false;
}

// ============================================================
// SHARED: ANNOUNCEMENTS
// ============================================================

function renderAnnouncements(){
  const backTarget = State.role === 'lecturer' ? 'dashboard' : 'home';
  const canPost = State.role === 'lecturer' || State.role === 'registrar';
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('${backTarget}')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Announcements</div>
    </div>
  </div>
  <div class="content" ${canPost ? 'style="padding-bottom:90px;"' : ''}>
    ${ANNOUNCEMENTS.length === 0 ? `<div class="empty-state">${ICONS.megaphone}<div class="t" style="margin-top:14px;">No announcements yet</div></div>` : ''}
    ${ANNOUNCEMENTS.map(a=>`
    <div class="card card-pad">
      <div class="section-head-row" style="margin-bottom:6px;">
        <div style="font-size:13.5px; font-weight:700;">${a.title}</div>
        <div style="font-size:10.5px; color:var(--ink-faint);">${a.date}</div>
      </div>
      <div style="font-size:12.5px; color:var(--ink-soft); line-height:1.5; margin-bottom:8px;">${a.body}</div>
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        <span class="tag-mini">${a.from}</span>
        ${a.course ? `<span class="tag-mini">${a.course}</span>` : ''}
      </div>
    </div>`).join('')}
  </div>

  ${canPost ? `
  <div class="sticky-footer">
    <div class="sticky-footer-inner" style="padding:8px; display:flex; gap:8px;">
      <button class="btn btn-ghost" style="flex:1;" onclick="navigate('sendNotification')">${ICONS.bell} Send Notification</button>
      <button class="btn btn-primary" style="flex:1;" onclick="openSheet('postAnnouncementSheet')">${ICONS.plus} Post Announcement</button>
    </div>
  </div>

  <div class="sheet" id="postAnnouncementSheet">
    <div class="sheet-handle"></div>
    <div class="sheet-title">
      <span>Post Announcement</span>
      <button onclick="closeSheet('postAnnouncementSheet')">${ICONS.close}</button>
    </div>
    <form id="announcementForm" onsubmit="return submitAnnouncement(event)" style="display:flex;flex-direction:column;gap:14px;">
      <div class="field">
        <label>Title <span class="req">*</span></label>
        <input class="input" id="announcementTitle" placeholder="e.g. Venue change for Friday" required />
      </div>
      <div class="field">
        <label>Message <span class="req">*</span></label>
        <textarea class="input" id="announcementBody" rows="4" placeholder="Write your announcement here..." style="height:auto;resize:vertical;" required></textarea>
      </div>
      ${State.role === 'lecturer' ? `
      <div class="field">
        <label>Course (optional)</label>
        <select class="select" id="announcementCourse">
          <option value="">All my courses</option>
          ${LECTURER_COURSES.map(c=>`<option value="${c.code}">${c.code} — ${c.name}</option>`).join('')}
        </select>
      </div>` : `
      <div class="field">
        <label>Course (optional)</label>
        <input class="input" id="announcementCourse" placeholder="e.g. CSC3103 (or leave blank for all)" />
      </div>`}
      <div class="btn-row" style="margin-top:6px;">
        <button type="button" class="btn btn-ghost" onclick="closeSheet('postAnnouncementSheet')">Cancel</button>
        <button type="submit" class="btn btn-primary">${ICONS.megaphone} Post</button>
      </div>
    </form>
  </div>` : ''}`;
}

// ============================================================
// SHARED: ATTENDANCE APPEALS (Student submits, Registrar approves)
// ============================================================

function submitAnnouncement(e){
  e.preventDefault();
  const title = document.getElementById('announcementTitle')?.value.trim();
  const body = document.getElementById('announcementBody')?.value.trim();
  const courseEl = document.getElementById('announcementCourse');
  const course = courseEl?.value || null;
  if(!title || !body){ showToast("Fill in title and message"); return false; }

  const newId = ANNOUNCEMENTS.length ? Math.max(...ANNOUNCEMENTS.map(a=>a.id)) + 1 : 1;
  ANNOUNCEMENTS.unshift({
    id: newId,
    from: State.user?.name || 'Unknown',
    course: course || null,
    title,
    body,
    date: new Date().toISOString().slice(0,10),
  });

  // Push a notification to students — scoped to the selected course if one
  // was chosen, otherwise all students (previous behavior). The course
  // dropdown existed before but wasn't wired into targeting; now it is.
  pushNotification({
    recipientRole: 'student',
    recipientId: null,
    type: 'announcement',
    title,
    body: body.slice(0, 120) + (body.length > 120 ? '…' : ''),
    courseCode: course || null,
    from: State.user?.name || 'Unknown',
    fromId: State.user?.id || State.user?.reg || State.user?.staffId || null,
  });

  closeSheet('postAnnouncementSheet');
  showToast("Announcement posted");
  navigate('announcements', { replace: true });
  return false;
}

// ============================================================
// SEND NOTIFICATION (Administrator / Lecturer / Registrar)
// Separate from Announcements: this is a private, targeted notification
// (inbox item) rather than a public announcement post. Recipient options
// are scoped by sender role — see recipientOptionsForRole() below.
// ============================================================

function recipientOptionsForRole(role){
  const base = [
    { value:'allStudents', label:'All Students', sub:'Every student, university-wide', icon:ICONS.users, color:'#1d4ed8', bg:'#dbeafe' },
    { value:'courseStudents', label:'Students in a Course', sub:'Everyone enrolled in one course', icon:ICONS.layers, color:'#0f766e', bg:'#ccfbf1' },
    { value:'specificStudent', label:'One Specific Student', sub:'A single student by name', icon:ICONS.user, color:'#7e22a3', bg:'#f3e8ff' },
  ];
  if(role === 'lecturer') return base;
  const withLecturers = [
    ...base,
    { value:'allLecturers', label:'All Lecturers', sub:'Every lecturer, university-wide', icon:ICONS.userCog, color:'#b45309', bg:'#fef3c7' },
    { value:'specificLecturer', label:'One Specific Lecturer', sub:'A single lecturer by name', icon:ICONS.userCog, color:'#b45309', bg:'#fef3c7' },
  ];
  if(role === 'registrar') return withLecturers;
  // administrator — broadest reach, including other registrars
  return [
    ...withLecturers,
    { value:'allRegistrars', label:'All Registrars', sub:'Every registrar, university-wide', icon:ICONS.shield, color:'#9c2220', bg:'#fee2e2' },
    { value:'specificRegistrar', label:'One Specific Registrar', sub:'A single registrar by name', icon:ICONS.shield, color:'#9c2220', bg:'#fee2e2' },
  ];
}

function renderComposeNotification(){
  const options = recipientOptionsForRole(State.role);
  const senderName = State.user?.name || 'You';
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('dashboard')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Send Notification</div>
      <button class="back-btn" onclick="navigate('sentNotifications')" title="Sent Notifications" style="margin-left:auto;">${ICONS.fileText || ICONS.bell}</button>
    </div>
  </div>
  <div class="content" style="padding-bottom:24px;">
    <form id="composeNotificationForm" onsubmit="return submitComposeNotification(event)" style="display:flex;flex-direction:column;gap:16px;">
      <input type="hidden" id="notifRecipientType" value="${options[0].value}" />

      <div>
        <div class="section-title" style="margin-bottom:8px;">${ICONS.users} Who should receive this?</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${options.map((o,i) => `
          <div class="report-option notif-recipient-tile" data-value="${o.value}" onclick="selectNotifRecipientType('${o.value}')" style="${i===0?'border-color:var(--theme-primary);border-width:2px;box-shadow:0 0 0 1px var(--theme-primary);':''}">
            <div class="ro-icon" style="background:${o.bg};color:${o.color};">${o.icon}</div>
            <div class="ro-text"><div class="t">${o.label}</div><div class="s">${o.sub}</div></div>
            <div class="notif-tile-check" style="color:var(--theme-primary);opacity:${i===0?'1':'0'};transition:opacity .15s;flex-shrink:0;">${ICONS.check}</div>
          </div>`).join('')}
        </div>
      </div>

      <div class="field" id="notifCourseField" style="display:none;">
        <label>Course</label>
        <select class="select" id="notifCourseSelect" onchange="updateNotifPreview()">
          ${COURSES.map(c => `<option value="${c.code}">${c.code} — ${c.name}</option>`).join('')}
        </select>
      </div>

      <div class="field" id="notifPersonField" style="display:none;">
        <label id="notifPersonLabel">Recipient</label>
        <select class="select" id="notifPersonSelect" onchange="updateNotifPreview()"></select>
      </div>

      <div class="field">
        <label>Title <span class="req">*</span></label>
        <input class="input" id="notifTitle" placeholder="e.g. Reminder: Submit your project" oninput="updateNotifPreview()" required />
      </div>

      <div class="field">
        <label>Message <span class="req">*</span></label>
        <textarea class="input" id="notifBody" rows="4" style="height:auto;resize:vertical;" placeholder="Write the notification message..." oninput="updateNotifPreview()" required></textarea>
        <div style="font-size:10.5px;color:var(--ink-faint);text-align:right;" id="notifBodyCounter">0 characters</div>
      </div>

      <div>
        <div class="section-title" style="margin-bottom:8px;">${ICONS.bell} Preview</div>
        <div class="card card-pad">
          <div class="student-card-row" style="align-items:flex-start;gap:12px;">
            <div style="width:36px;height:36px;border-radius:50%;background:#eef2ff;flex-shrink:0;display:flex;align-items:center;justify-content:center;">
              <div style="color:var(--theme-primary);display:flex;">${ICONS.bell.replace(/<svg /,'<svg style="width:16px;height:16px;" ')}</div>
            </div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:800;" id="notifPreviewTitle">Notification title</div>
              <div style="font-size:11.5px;color:var(--ink-soft);margin-top:3px;line-height:1.4;" id="notifPreviewBody">Your message will appear here as you type...</div>
              <div style="font-size:10.5px;color:var(--ink-faint);margin-top:4px;" id="notifPreviewMeta">From ${senderName} · Today</div>
            </div>
          </div>
        </div>
      </div>

      <button type="submit" class="btn btn-primary">${ICONS.bell} Send Notification</button>
    </form>
  </div>`;
}

// Tapping a recipient tile updates the hidden form value, the tiles'
// selected-state styling, the conditional course/person pickers, and the
// live preview — all via direct DOM writes, deliberately NOT a full
// rerenderCurrentScreen(), which would wipe whatever the person has typed
// into Title/Message so far.
function selectNotifRecipientType(value){
  const hidden = document.getElementById('notifRecipientType');
  if(hidden) hidden.value = value;
  document.querySelectorAll('.notif-recipient-tile').forEach(el => {
    const selected = el.dataset.value === value;
    el.style.borderColor = selected ? 'var(--theme-primary)' : '';
    el.style.borderWidth = selected ? '2px' : '';
    el.style.boxShadow = selected ? '0 0 0 1px var(--theme-primary)' : '';
    const chk = el.querySelector('.notif-tile-check');
    if(chk) chk.style.opacity = selected ? '1' : '0';
  });
  updateComposeNotificationFields(value);
  updateNotifPreview();
}

// Populate the course/person pickers based on the chosen recipient type,
// and toggle their visibility. Called on screen load and on tile selection.
function updateComposeNotificationFields(recipientType){
  const courseField = document.getElementById('notifCourseField');
  const personField = document.getElementById('notifPersonField');
  const personSelect = document.getElementById('notifPersonSelect');
  const personLabel = document.getElementById('notifPersonLabel');
  if(!courseField || !personField || !personSelect || !personLabel) return;

  courseField.style.display = recipientType === 'courseStudents' ? '' : 'none';

  const personSources = {
    specificStudent: { list: STUDENTS, idKey:'reg', nameKey:'name', label:'Student' },
    specificLecturer: { list: LECTURERS, idKey:'id', nameKey:'name', label:'Lecturer' },
    specificRegistrar: { list: REGISTRARS, idKey:'id', nameKey:'name', label:'Registrar' },
  };
  const source = personSources[recipientType];
  if(source){
    personField.style.display = '';
    personLabel.textContent = source.label;
    personSelect.innerHTML = source.list.map(p => `<option value="${p[source.idKey]}">${p.name}${p.reg ? ' — ' + p.reg : ''}</option>`).join('');
  } else {
    personField.style.display = 'none';
  }
}

// Live-updates the preview card and character counter as the person types
// or changes any selector — purely cosmetic, no data mutation.
function updateNotifPreview(){
  const titleEl = document.getElementById('notifTitle');
  const bodyEl = document.getElementById('notifBody');
  const previewTitle = document.getElementById('notifPreviewTitle');
  const previewBody = document.getElementById('notifPreviewBody');
  const counter = document.getElementById('notifBodyCounter');
  if(previewTitle) previewTitle.textContent = titleEl?.value.trim() || 'Notification title';
  if(previewBody) previewBody.textContent = bodyEl?.value.trim() || 'Your message will appear here as you type...';
  if(counter) counter.textContent = `${bodyEl?.value.length || 0} characters`;
}

function submitComposeNotification(e){
  e.preventDefault();
  const recipientType = document.getElementById('notifRecipientType')?.value;
  const title = document.getElementById('notifTitle')?.value.trim();
  const body = document.getElementById('notifBody')?.value.trim();
  if(!title || !body){ showToast("Fill in title and message"); return false; }

  const roleByType = {
    allStudents:'student', courseStudents:'student', specificStudent:'student',
    allLecturers:'lecturer', specificLecturer:'lecturer',
    allRegistrars:'registrar', specificRegistrar:'registrar',
  };
  const recipientRole = roleByType[recipientType];
  let recipientId = null;
  let courseCode = null;

  if(recipientType === 'courseStudents'){
    courseCode = document.getElementById('notifCourseSelect')?.value || null;
  } else if(recipientType.startsWith('specific')){
    recipientId = document.getElementById('notifPersonSelect')?.value || null;
    if(!recipientId){ showToast("Choose a recipient"); return false; }
  }

  pushNotification({ recipientRole, recipientId, courseCode, type:'general', title, body, from: State.user?.name || 'Unknown', fromId: State.user?.id || State.user?.reg || State.user?.staffId || null });

  showToast("Notification sent");
  navigate('dashboard', { replace: true });
  return false;
}

function renderSentNotifications(){
  const userId = State.user?.id || State.user?.reg || State.user?.staffId;
  const mine = SENT_NOTIFICATIONS.filter(n => n.fromId === userId);
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('sendNotification')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Outbox</div>
    </div>
  </div>
  <div class="content">
    ${mine.length === 0 ? `
      <div class="empty-state">
        ${ICONS.bell}
        <div class="t" style="margin-top:14px;">Nothing sent yet</div>
        <div class="s">Notifications you send will show up here</div>
      </div>
    ` : `
      <div class="card card-pad">
        <div style="display:flex;flex-direction:column;gap:0;">
          ${mine.map(n => {
            const preview = n.body.length > 60 ? n.body.slice(0, 60) + '…' : n.body;
            return `
          <div class="notif-row" onclick="toggleNotifExpand('sent-${n.id}')" style="cursor:pointer;align-items:flex-start;gap:12px;display:flex;padding:12px 0;border-bottom:1px solid var(--line);">
            <div style="width:36px;height:36px;border-radius:50%;background:#eef2ff;flex-shrink:0;display:flex;align-items:center;justify-content:center;">
              <div style="color:var(--theme-primary);display:flex;">${ICONS.bell.replace(/<svg /,'<svg style="width:16px;height:16px;" ')}</div>
            </div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:800;">${n.title}</div>
              <div class="notif-preview" id="notif-preview-sent-${n.id}" style="font-size:11.5px;color:var(--ink-soft);margin-top:3px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${preview}</div>
              <div class="notif-full" id="notif-full-sent-${n.id}" style="display:none;font-size:11.5px;color:var(--ink-soft);margin-top:3px;line-height:1.4;">${n.body}</div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;">
                <span class="tag-mini">${describeNotificationRecipient(n)}</span>
                <span class="tag-mini">${formatNotifTimestamp(n)}</span>
              </div>
            </div>
            <div id="notif-chevron-sent-${n.id}" style="color:var(--ink-faint);flex-shrink:0;margin-top:2px;transition:transform .15s;">${ICONS.chevR}</div>
          </div>`;
          }).join('')}
        </div>
      </div>
    `}
  </div>`;
}

function renderAppeals(){
  const isRegistrar = State.role === 'registrar';
  const backTarget = isRegistrar ? 'dashboard' : 'home';
  const appeals = scopedAppeals();
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('${backTarget}')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">${isRegistrar ? 'Appeals & Disputes' : 'Attendance Appeals'}</div>
    </div>
  </div>
  <div class="content">
    ${!isRegistrar ? `
    <a class="quick-action solid" onclick="openSheet('newAppealSheet')">
      <div class="qa-icon">${ICONS.gavel}</div>
      <div class="qa-text"><div class="t">Submit New Appeal</div><div class="s">Dispute an attendance record</div></div>
      <div class="chev">${ICONS.chevR}</div>
    </a>` : ''}

    <div class="card card-pad">
      <div class="section-title">${ICONS.fileText} ${isRegistrar ? 'All Appeals' : 'My Appeals'}</div>
      <div style="display:flex; flex-direction:column; gap:10px;">
        ${appeals.map(ap=>`
        <div class="record-card">
          <div class="record-main">
            <div class="record-top">
              <div class="record-name">${ap.student}</div>
              <div class="record-date">${ap.session}</div>
            </div>
            <div class="record-sub">${ap.course}</div>
            <div style="font-size:12px; color:var(--ink-soft); margin-top:6px; line-height:1.4;">${ap.reason}</div>
          </div>
          <span class="status-pill ${ap.status==='resolved'?'present':'late'}">${ap.status}</span>
        </div>
        ${isRegistrar && ap.status==='pending' ? `
        <div class="btn-row" style="margin-top:-4px;">
          <button class="btn btn-ghost" style="font-size:12px; padding:9px;" onclick="resolveAppeal('${ap.id}', false)">Deny</button>
          <button class="btn btn-primary" style="font-size:12px; padding:9px; background:var(--present);" onclick="resolveAppeal('${ap.id}', true)">Approve</button>
        </div>` : ''}
        `).join('') || `<div class="empty-state-sm">${isRegistrar ? 'No appeals in your faculty' : 'No appeals submitted yet'}</div>`}
      </div>
    </div>
  </div>

  <div class="sheet" id="newAppealSheet">
    <div class="sheet-handle"></div>
    <div class="sheet-title">
      <span>Submit Attendance Appeal</span>
      <button onclick="closeSheet('newAppealSheet')">${ICONS.close}</button>
    </div>
    <form onsubmit="return handleAppealSubmit(event)" style="display:flex; flex-direction:column; gap:14px;">
      <div class="field">
        <label>Course <span class="req">*</span></label>
        <select class="select" id="appealCourse">
          ${STUDENT_COURSES.map(c=>`<option value="${c.code}">${c.code} — ${c.name}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Session Date <span class="req">*</span></label>
        <input class="input" type="date" id="appealDate" required />
      </div>
      <div class="field">
        <label>Reason <span class="req">*</span></label>
        <textarea class="input" id="appealReason" rows="4" placeholder="Explain why this record should be reviewed..." required style="resize:vertical;"></textarea>
      </div>
      <button class="btn btn-primary" type="submit">${ICONS.gavel} Submit Appeal</button>
    </form>
  </div>`;
}

function handleAppealSubmit(e){
  e.preventDefault();
  const courseCode = document.getElementById('appealCourse')?.value;
  const course = STUDENT_COURSES.find(c => c.code === courseCode);
  const date = document.getElementById('appealDate')?.value;
  const reason = document.getElementById('appealReason')?.value.trim();
  if(!date || !reason){
    showToast("Fill in the session date and reason");
    return false;
  }
  const newId = ATTENDANCE_APPEALS.length ? Math.max(...ATTENDANCE_APPEALS.map(a=>a.id)) + 1 : 1;
  const courseLabel = course ? `${course.code} — ${course.name}` : (courseCode || 'Unknown course');
  const appealObj = {
    id: newId,
    supabaseId: null, // filled in once the live insert below resolves, so resolveAppeal() can target the real row
    student: State.user.name,
    course: courseLabel,
    session: date,
    reason,
    status: 'pending',
  };
  ATTENDANCE_APPEALS.push(appealObj);
  liveWriteAppeal(appealObj); // fire-and-forget — local push above already succeeded either way
  closeSheet('newAppealSheet');
  showToast("Appeal submitted for review");
  navigate('appeals', { replace: true });
  return false;
}

function resolveAppeal(id, approved){
  const appeal = ATTENDANCE_APPEALS.find(a => String(a.id) === String(id));
  if(appeal){
    appeal.status = approved ? 'approved' : 'rejected';
    logAuditEvent(State.user?.staffId||'system', State.user?.name||'System', `Appeal ${approved?'approved':'rejected'}`, `appeal-${id}`, `${appeal.student} — ${appeal.course}`);
    liveResolveAppeal(appeal, approved); // fire-and-forget — local status change above already succeeded either way
  }
  showToast(approved ? "Appeal approved — record updated" : "Appeal denied");
  // refreshScreenContentOnly(), not rerenderCurrentScreen(): the local status
  // above is already correct, so there's no need to re-fetch from Supabase
  // here — doing so via rerenderCurrentScreen() would re-trigger the
  // "load appeals on visit" hook, and that fresh fetch can land before the
  // liveResolveAppeal() write above actually commits, overwriting this
  // optimistic update back to the still-stale "pending" from the database
  // (exactly what caused approve/deny to visually need two clicks).
  refreshScreenContentOnly();
}

// ------------------------------------------------------------
// ATTENDANCE APPEALS — live read/write (Gate 4, part 7 — the last piece).
// Same additive/fallback pattern as everything else. supabaseId tracks the
// real row once an insert round-trips, so a resolve action shortly after
// submission can still find and update the right row; if it resolves
// faster than the write does, resolveAppeal() simply stays local-only for
// that appeal (same small race tolerated everywhere else in Gate 4).
// ------------------------------------------------------------

async function liveWriteAppeal(appealObj){
  if(!LIVE_BACKEND) return;
  try {
    const { data, error } = await SUPABASE_CLIENT
      .from('attendance_appeals')
      .insert({
        student_id: State.user?.id || State.user?.reg || State.user?.staffId || null,
        student_name: appealObj.student,
        course: appealObj.course,
        session_date: appealObj.session || null,
        reason: appealObj.reason,
        status: appealObj.status,
      })
      .select()
      .single();
    if(error){ console.warn('liveWriteAppeal failed:', error); return; }
    if(data) appealObj.supabaseId = data.id;
  } catch(e){
    console.warn('liveWriteAppeal error:', e);
  }
}

async function liveResolveAppeal(appeal, approved){
  if(!LIVE_BACKEND) return;
  if(!appeal.supabaseId){
    console.warn('liveResolveAppeal: no supabaseId yet for this appeal — insert may still be in flight, skipping live update');
    return;
  }
  try {
    const { error } = await SUPABASE_CLIENT
      .from('attendance_appeals')
      .update({
        status: approved ? 'approved' : 'rejected',
        resolved_at: new Date().toISOString(),
        resolved_by: State.user?.name || 'Unknown',
      })
      .eq('id', appeal.supabaseId);
    if(error) console.warn('liveResolveAppeal failed:', error);
  } catch(e){
    console.warn('liveResolveAppeal error:', e);
  }
}

async function loadAppealsFromSupabase(){
  if(!LIVE_BACKEND) return;
  try {
    const { data: rows, error } = await SUPABASE_CLIENT
      .from('attendance_appeals')
      .select('*')
      .order('created_at', { ascending: false });

    if(error){ console.warn('Appeals fetch failed, keeping mock ATTENDANCE_APPEALS:', error); return; }
    if(!rows || rows.length === 0) return; // no live rows yet — keep mock so the list isn't empty

    const fetched = rows.map(r => ({
      id: r.id,
      supabaseId: r.id,
      student: r.student_name,
      studentId: r.student_id,
      course: r.course,
      session: r.session_date,
      reason: r.reason,
      status: r.status,
    }));

    // Merge rather than replace: an appeal just submitted in this session
    // may not have committed yet by the time this fetch lands (same
    // read-after-write race as Sent Notifications). Keep any local-only
    // appeal (no supabaseId yet) that isn't already present in the fetch.
    const isDuplicate = (local, live) => local.student === live.student && local.course === live.course &&
      local.session === live.session && local.reason === live.reason;
    const localOnly = ATTENDANCE_APPEALS.filter(local => !local.supabaseId && !fetched.some(live => isDuplicate(local, live)));

    ATTENDANCE_APPEALS.length = 0;
    ATTENDANCE_APPEALS.push(...localOnly, ...fetched);
    refreshScreenContentOnly(); // hook-free — see its own comment for why not rerenderCurrentScreen()
  } catch(e){
    console.warn('loadAppealsFromSupabase error, keeping mock ATTENDANCE_APPEALS:', e);
  }
}

// ============================================================
// REGISTRAR: SCHEDULE CLASSES
// ============================================================
// "Create New Class Session" now lives directly on the Schedules bottom-nav
// tab (renderSchedule with showCreateSession:true) — see NAV_CONFIG.registrar
// and the 'allSchedules' case in getScreenHTML. The standalone screen that
// used to live here was removed as part of the Registrar dashboard's
// Data Analytics & Reports restructure; renderNewSessionFormBody(),
// openNewSessionSheet(), onSessionCourseChange() and submitNewSession()
// below are shared by that merged screen unchanged.

// Sept 2026 handoff (Register/Timetable/Records), Part 2: renderNewSessionFormBody()
// now doubles as the edit form — pass `existing` as {day, index} to prefill
// and switch to "Save Changes"; omit it (or pass null) for a fresh Create
// form. The day/index are carried as hidden inputs rather than a module-level
// variable, so there's no extra state to remember to reset on login/logout
// (gotcha #7) — the form always fully re-renders itself on open (see
// openNewSessionSheet()) and reads its own hidden fields on submit.
function renderNewSessionFormBody(existing){
  // Scope course list to the Registrar's own faculty, if applicable — reuses
  // the same scopedCourses() the Course Catalog itself uses (Part 2), so the
  // two can never drift on which courses a given Registrar can see.
  const courseOptions = scopedCourses();

  const lecture = existing ? (SCHEDULE.find(d => d.day === existing.day)?.lectures || [])[existing.index] : null;
  const timeParts = lecture ? String(lecture.time || '').split('–').map(s => s.trim()) : [];
  const startVal = timeParts[0] || '08:00';
  const endVal = timeParts[1] || '10:00';

  return `
    <form id="newSessionForm" onsubmit="return submitNewSession(event)" style="display:flex;flex-direction:column;gap:14px;">
      ${existing ? `<input type="hidden" id="sessionEditDay" value="${existing.day}" /><input type="hidden" id="sessionEditIndex" value="${existing.index}" />` : ''}
      <div class="field">
        <label>Day <span class="req">*</span></label>
        <select class="select" id="sessionDay">
          ${SCHEDULE.map(d => `<option value="${d.day}" ${(lecture ? existing.day===d.day : d.isToday) ?'selected':''}>${d.day}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Course <span class="req">*</span></label>
        <select class="select" id="sessionCourse" onchange="onSessionCourseChange()">
          <option value="">Select a course...</option>
          ${courseOptions.map(c => `<option value="${c.code}" ${lecture && lecture.code===c.code ? 'selected':''}>${c.code} — ${c.name}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Lecturer <span class="req">*</span></label>
        <select class="select" id="sessionLecturer">
          <option value="">Select a lecturer...</option>
          ${LECTURERS.map(l => `<option value="${l.name}" ${lecture && lecture.lecturer===l.name ? 'selected':''}>${l.name}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Room <span class="req">*</span></label>
        <input class="input" id="sessionRoom" value="${lecture ? lecture.room : ''}" placeholder="e.g. LT1 - Main Building" />
      </div>
      <div class="field-row">
        <div class="field">
          <label>Start Time <span class="req">*</span></label>
          <input class="input" type="time" id="sessionStart" value="${startVal}" />
        </div>
        <div class="field">
          <label>End Time <span class="req">*</span></label>
          <input class="input" type="time" id="sessionEnd" value="${endVal}" />
        </div>
      </div>
      <div class="field">
        <label>Mode</label>
        <select class="select" id="sessionMode">
          <option value="" ${!lecture || !lecture.mode ? 'selected' : ''}>No restriction</option>
          <option value="day" ${lecture && lecture.mode==='day' ? 'selected' : ''}>Day</option>
          <option value="evening" ${lecture && lecture.mode==='evening' ? 'selected' : ''}>Evening</option>
        </select>
      </div>
      <div class="btn-row" style="margin-top:6px;">
        <button type="button" class="btn btn-ghost" onclick="closeSheet('newSessionSheet')">Cancel</button>
        <button type="submit" class="btn btn-primary">${ICONS.check} ${existing ? 'Save Changes' : 'Add to Schedule'}</button>
      </div>
    </form>`;
}

function onSessionCourseChange(){
  // Auto-fill lecturer from the course catalog if a lecturer is assigned
  const code = document.getElementById('sessionCourse')?.value;
  const course = COURSES.find(c => c.code === code);
  if(course && course.lecturer){
    const lecSel = document.getElementById('sessionLecturer');
    if(lecSel){
      for(const opt of lecSel.options){
        if(opt.value === course.lecturer){
          lecSel.value = course.lecturer;
          break;
        }
      }
    }
  }
}

function openNewSessionSheet(day, index){
  const editing = (day !== undefined && index !== undefined);
  const title = document.getElementById('newSessionSheetTitle');
  if(title) title.textContent = editing ? 'Edit Class Session' : 'New Class Session';
  const body = document.getElementById('newSessionBody');
  if(body) body.innerHTML = renderNewSessionFormBody(editing ? { day, index } : null);
  openSheet('newSessionSheet');
}

function submitNewSession(e){
  e.preventDefault();
  const editDay = document.getElementById('sessionEditDay')?.value;
  const editIndex = document.getElementById('sessionEditIndex')?.value;
  const isEdit = editDay !== undefined && editDay !== null && editDay !== '' && editIndex !== undefined && editIndex !== null && editIndex !== '';

  const day = document.getElementById('sessionDay')?.value;
  const courseCode = document.getElementById('sessionCourse')?.value;
  const lecturer = document.getElementById('sessionLecturer')?.value;
  const room = document.getElementById('sessionRoom')?.value.trim();
  const startTime = document.getElementById('sessionStart')?.value;
  const endTime = document.getElementById('sessionEnd')?.value;
  const mode = document.getElementById('sessionMode')?.value || null; // '' -> null ("no restriction")

  if(!courseCode){ showToast("Select a course"); return false; }
  if(!lecturer){ showToast("Select a lecturer"); return false; }
  if(!room){ showToast("Enter a room"); return false; }
  if(!startTime || !endTime || startTime >= endTime){ showToast("End time must be after start time"); return false; }

  const course = COURSES.find(c => c.code === courseCode);
  const timeStr = `${startTime} – ${endTime}`;

  const dayEntry = SCHEDULE.find(d => d.day === day);
  if(!dayEntry){ showToast("Day not found"); return false; }

  const newLecture = {
    code: courseCode,
    name: course ? course.name : courseCode,
    dept: course ? (course.programme || '') : '',
    lecturer,
    room,
    time: timeStr,
    mode: mode || null,
  };

  // Store old lecture data for edit comparison (Part 3: reschedule announcements)
  let oldLecture = null;
  if(isEdit){
    const oldDayEntry = SCHEDULE.find(d => d.day === editDay);
    if(oldDayEntry && oldDayEntry.lectures[parseInt(editIndex, 10)]){
      oldLecture = oldDayEntry.lectures[parseInt(editIndex, 10)];
    }
  }

  // Apply local mock change optimistically
  if(isEdit){
    // Editing can also move a slot to a different day — remove from the old
    // day/index first, then push onto the (possibly different) target day,
    // rather than mutating in place, so a day change can't leave a stale
    // duplicate behind on the original day.
    const oldDayEntry = SCHEDULE.find(d => d.day === editDay);
    if(oldDayEntry) oldDayEntry.lectures.splice(parseInt(editIndex, 10), 1);
    dayEntry.lectures.push(newLecture);
    logAuditEvent(State.user?.staffId||'system', State.user?.name||'System', 'Class session updated', courseCode, `${course?.name||courseCode} on ${day} at ${timeStr}`);
    closeSheet('newSessionSheet');
    showToast(`${course?.name||courseCode} updated`);
  } else {
    dayEntry.lectures.push(newLecture);
    logAuditEvent(State.user?.staffId||'system', State.user?.name||'System', 'Class session scheduled', courseCode, `${course?.name||courseCode} on ${day} at ${timeStr}`);
    closeSheet('newSessionSheet');
    showToast(`${course?.name||courseCode} added to ${day}`);
  }

  // Fire live write if backend is enabled
  if(LIVE_BACKEND){
    (async () => {
      try {
        // Resolve class_id and teacher_id from course code and lecturer name
        const { data: classRow, error: classErr } = await SUPABASE_CLIENT
          .from('classes')
          .select('id, teacher_id')
          .eq('code', courseCode)
          .maybeSingle();
        
        if(classErr || !classRow){
          console.warn('Timetable write: classes lookup failed, keeping local change:', classErr);
          return; // Keep local change, don't fail the UI
        }

        const { data: userRow, error: userErr } = await SUPABASE_CLIENT
          .from('users')
          .select('id')
          .eq('name', lecturer)
          .maybeSingle();
        
        if(userErr || !userRow){
          console.warn('Timetable write: lecturer lookup failed, keeping local change:', userErr);
          return; // Keep local change, don't fail the UI
        }

        const slotData = {
          class_id: classRow.id,
          day_of_week: day,
          start_time: startTime,
          end_time: endTime,
          room,
          mode: mode || null,
          // The lecturer picked in this specific session's form — not
          // classes.teacher_id, which is fixed per course and can't tell two
          // different courses' sessions taught by the same real person
          // apart, nor let one session diverge from the course's default
          // teacher. This is what the conflict trigger now checks (see
          // migrate-per-session-lecturer.sql).
          teacher_id: userRow.id,
        };

        let result;
        if(isEdit){
          // Prefer the live row's own id, carried on oldLecture if it came
          // from loadTimetableFromSupabase() — direct id lookup sidesteps
          // any risk of a field-matching mismatch (e.g. Postgres returning
          // "08:00:00" for a time column while the mock/display value is
          // "08:00") entirely, rather than depending on the two staying in
          // sync. Only fall back to field-matching for a slot that's never
          // been live before (no id to target yet).
          let existingSlotId = oldLecture?._liveSlotId || null;
          if(!existingSlotId){
            const { data: existingSlots, error: findErr } = await SUPABASE_CLIENT
              .from('timetable_slots')
              .select('id')
              .eq('class_id', classRow.id)
              .eq('day_of_week', editDay)
              .eq('start_time', oldLecture.time.split(' – ')[0])
              .eq('end_time', oldLecture.time.split(' – ')[1])
              .eq('room', oldLecture.room)
              .maybeSingle();

            if(findErr || !existingSlots){
              console.warn('Timetable edit: existing slot not found, keeping local change:', findErr);
              return;
            }
            existingSlotId = existingSlots.id;
          }

          result = await SUPABASE_CLIENT
            .from('timetable_slots')
            .update(slotData)
            .eq('id', existingSlotId);

          // Part 3: Send reschedule announcement if day/time/room changed
          if(!result.error && oldLecture){
            const dayChanged = editDay !== day;
            const timeChanged = oldLecture.time !== timeStr;
            const roomChanged = oldLecture.room !== room;
            
            if(dayChanged || timeChanged || roomChanged){
              // Fetch enrolled students for this course
              const { data: enrollments } = await SUPABASE_CLIENT
                .from('enrollments')
                .select('student_id')
                .eq('class_id', classRow.id);
              
              const studentIds = enrollments?.map(e => e.student_id) || [];
              
              // Build notification body describing what changed
              const changes = [];
              if(dayChanged) changes.push(`moved from ${editDay} to ${day}`);
              if(timeChanged) changes.push(`rescheduled from ${oldLecture.time} to ${timeStr}`);
              if(roomChanged) changes.push(`relocated from ${oldLecture.room} to ${room}`);
              
              const notifBody = `Your ${course?.name||courseCode} session has been ${changes.join(', ')}.`;
              
              // Send to students
              studentIds.forEach(studentId => {
                pushNotification({
                  recipientRole: 'student',
                  recipientId: studentId,
                  type: 'reschedule',
                  title: `Schedule Change: ${course?.name||courseCode}`,
                  body: notifBody,
                  courseCode,
                  from: 'System',
                  fromId: 'system',
                });
              });
              
              // Send to lecturer
              pushNotification({
                recipientRole: 'lecturer',
                recipientId: userRow.id,
                type: 'reschedule',
                title: `Schedule Change: ${course?.name||courseCode}`,
                body: notifBody,
                courseCode,
                from: 'System',
                fromId: 'system',
              });
            }
          }
        } else {
          // Insert new slot
          result = await SUPABASE_CLIENT
            .from('timetable_slots')
            .insert(slotData);
        }

        if(result.error){
          // Database trigger rejected the write (room or lecturer conflict)
          // Roll back local change and show the actual error message
          console.warn('Timetable write rejected by database trigger:', result.error);
          
          // Roll back local change
          if(isEdit){
            // Put the old lecture back where it was
            const oldDayEntry = SCHEDULE.find(d => d.day === editDay);
            if(oldDayEntry){
              oldDayEntry.lectures.splice(parseInt(editIndex, 10), 0, oldLecture);
            }
            // Remove the new lecture from the target day
            const targetDayEntry = SCHEDULE.find(d => d.day === day);
            if(targetDayEntry){
              const newIdx = targetDayEntry.lectures.findIndex(l => 
                l.code === newLecture.code && l.room === newLecture.room && l.time === newLecture.time
              );
              if(newIdx >= 0) targetDayEntry.lectures.splice(newIdx, 1);
            }
          } else {
            // Remove the newly added lecture
            const removeIdx = dayEntry.lectures.findIndex(l => 
              l.code === newLecture.code && l.room === newLecture.room && l.time === newLecture.time
            );
            if(removeIdx >= 0) dayEntry.lectures.splice(removeIdx, 1);
          }
          
          // Show the actual conflict message from the database
          showToast(`Schedule conflict: ${result.error.message}`);
          refreshScreenContentOnly();
        }
      } catch(err){
        console.warn('Timetable write error, keeping local change:', err);
        // Keep local change, don't fail the UI
      }
    })();
  }

  navigate('allSchedules', { replace: true });
  return false;
}

function confirmDeleteSlot(day, index){
  const dayEntry = SCHEDULE.find(d => d.day === day);
  if(!dayEntry) return;
  const lecture = dayEntry.lectures[index];
  if(!lecture) return;
  
  // Store lecture data for live deletion
  const lectureToDelete = { ...lecture };
  
  // Apply local mock change optimistically
  dayEntry.lectures.splice(index, 1);
  logAuditEvent(State.user?.staffId||'system', State.user?.name||'System', 'Class session removed', lecture.code, `${lecture.name} removed from ${day}`);
  showToast(`${lecture.name} removed from ${day}`);
  
  // Fire live delete if backend is enabled
  if(LIVE_BACKEND){
    (async () => {
      try {
        // Resolve class_id from course code
        const { data: classRow, error: classErr } = await SUPABASE_CLIENT
          .from('classes')
          .select('id')
          .eq('code', lecture.code)
          .maybeSingle();
        
        if(classErr || !classRow){
          console.warn('Timetable delete: classes lookup failed, keeping local change:', classErr);
          return; // Keep local change, don't fail the UI
        }

        // Prefer the live row's own id when this lecture came from a live
        // load — see the matching comment in submitNewSession() for why.
        let existingSlotId = lectureToDelete._liveSlotId || null;
        if(!existingSlotId){
          const timeParts = lecture.time.split(' – ');
          const { data: existingSlot, error: findErr } = await SUPABASE_CLIENT
            .from('timetable_slots')
            .select('id')
            .eq('class_id', classRow.id)
            .eq('day_of_week', day)
            .eq('start_time', timeParts[0])
            .eq('end_time', timeParts[1])
            .eq('room', lecture.room)
            .maybeSingle();

          if(findErr || !existingSlot){
            console.warn('Timetable delete: slot not found, keeping local change:', findErr);
            return; // Keep local change, don't fail the UI
          }
          existingSlotId = existingSlot.id;
        }

        const { error: deleteErr } = await SUPABASE_CLIENT
          .from('timetable_slots')
          .delete()
          .eq('id', existingSlotId);
        
        if(deleteErr){
          console.warn('Timetable delete failed, keeping local change:', deleteErr);
          // Keep local change, don't fail the UI
        }
      } catch(err){
        console.warn('Timetable delete error, keeping local change:', err);
        // Keep local change, don't fail the UI
      }
    })();
  }
  
  navigate('allSchedules', { replace: true });
}

// ============================================================
// REGISTRAR: LECTURER COMPLIANCE
// ============================================================

function renderCompliance(){
  const fk = currentRegistrarFacultyKey();
  const facultyAnalytics = fk ? FACULTY_ANALYTICS.filter(f=>f.facultyKey===fk) : FACULTY_ANALYTICS;
  const facultiesToShow = fk ? FACULTIES.filter(f=>f.key===fk) : FACULTIES;
  return `
  <div class="app-header">
    <div class="header-back">
      <button class="back-btn" onclick="navigate('dataAnalytics')">${ICONS.back}</button>
      <div class="page-title" style="font-size:18px;">Analytics & Compliance</div>
    </div>
  </div>
  <div class="content">
    <div class="card card-pad">
      <div class="section-head-row">
        <div class="section-title" style="margin-bottom:0;">${ICONS.scaleIcon} Lecturer Compliance Report</div>
        <div style="display:flex; gap:10px;">
          <button class="link-mini" onclick="exportComplianceReport('pdf')">${ICONS.fileText} PDF</button>
          <button class="link-mini" onclick="exportComplianceReport('excel')">${ICONS.fileSpreadsheet} CSV</button>
        </div>
      </div>
      <div style="font-size:11.5px; color:var(--ink-faint);">Exports ${scopedLecturerCompliance().length} lecturer${scopedLecturerCompliance().length===1?'':'s'} in your faculty</div>
    </div>

    <div class="card card-pad">
      <div class="section-title">${ICONS.building} Faculty Attendance</div>
      <div style="display:flex; flex-direction:column; gap:10px;">
        ${facultyAnalytics.map(f=>`
        <div class="lecture-row">
          <div>
            <div class="lecture-code" style="font-size:13px;">${f.faculty}</div>
            <div class="lecture-meta" style="margin-top:3px;">${f.students} students · ${f.programmes} programmes</div>
          </div>
          <span class="badge ${f.avgAttendance>=85?'done':'pending'}">${f.avgAttendance}%</span>
        </div>`).join('')}
      </div>
    </div>

    <div class="card card-pad">
      <div class="section-title">${ICONS.scaleIcon} Session Delivery Rate</div>
      <div style="display:flex; flex-direction:column; gap:12px;">
        ${scopedLecturerCompliance().map(l=>`
        <div>
          <div class="section-head-row" style="margin-bottom:6px;">
            <span style="font-size:13px; font-weight:700;">${l.lecturer}</span>
            <span style="font-size:12.5px; font-weight:800; color:${l.complianceRate>=90?'var(--present)':l.complianceRate>=80?'var(--late)':'var(--absent)'};">${l.complianceRate}%</span>
          </div>
          <div style="background:var(--unmarked-bg); border-radius:var(--radius-pill); height:8px; overflow:hidden;">
            <div style="background:${l.complianceRate>=90?'var(--present)':l.complianceRate>=80?'var(--late)':'var(--absent)'}; height:100%; width:${l.complianceRate}%;"></div>
          </div>
          <div style="font-size:11px; color:var(--ink-faint); margin-top:4px;">${l.sessionsHeld} of ${l.sessionsExpected} sessions held</div>
        </div>`).join('') || `<div class="empty-state-sm">No lecturer data in your faculty</div>`}
      </div>
    </div>

    <div class="card card-pad">
      <div class="section-title">${ICONS.chart} Programme Analytics</div>
      ${facultiesToShow.map(fac => `
      <div style="margin-bottom:14px;">
        <div style="font-size:11px; font-weight:800; color:var(--ink-faint); text-transform:uppercase; letter-spacing:0.3px; margin-bottom:8px;">${fac.name}</div>
        <div style="display:flex; flex-direction:column; gap:10px;">
          ${PROGRAMME_ANALYTICS.filter(p=>p.facultyKey===fac.key).map(p=>`
          <div class="lecture-row">
            <div>
              <div class="lecture-code" style="font-size:13px;">${p.programme}</div>
              <div class="lecture-meta" style="margin-top:3px;">${p.students} students</div>
            </div>
            <span class="badge ${p.avgAttendance===0?'pending':p.avgAttendance>=85?'done':'pending'}">${p.avgAttendance ? p.avgAttendance+'%' : 'No data'}</span>
          </div>`).join('')}
        </div>
      </div>`).join('')}
    </div>
  </div>`;
}

// Lecturer Compliance's own export action — same shape/pattern as
// exportReport() above (CSV via Blob download, PDF via print-dialog window),
// just built from scopedLecturerCompliance() instead of scopedRecords().
function exportComplianceReport(format){
  const data = scopedLecturerCompliance();
  if(data.length === 0){
    showToast("No lecturer compliance data to export");
    return;
  }

  if(format === 'excel'){
    const headers = ['Lecturer','Sessions Held','Sessions Expected','Compliance Rate (%)'];
    const rows = data.map(l => [
      `"${l.lecturer}"`,
      l.sessionsHeld,
      l.sessionsExpected,
      l.complianceRate,
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vusap-lecturer-compliance-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    logAuditEvent(State.user?.staffId||'system', State.user?.name||'System', 'Report exported', 'lecturer-compliance', `CSV, ${data.length} lecturers`);
    showToast(`${data.length} lecturer records exported as CSV`, ICONS.download.replace(/width="\d+" height="\d+"/,'width="15" height="15"'));

  } else if(format === 'pdf'){
    const html = `<!DOCTYPE html><html><head><title>VUSAP Lecturer Compliance Report</title>
    <style>
      body{font-family:sans-serif;font-size:12px;color:#111;padding:24px;}
      h1{font-size:18px;margin-bottom:4px;}
      .meta{color:#666;font-size:11px;margin-bottom:20px;}
      table{width:100%;border-collapse:collapse;}
      th{background:#1e293b;color:#fff;padding:8px 10px;text-align:left;font-size:11px;}
      td{padding:7px 10px;border-bottom:1px solid #e2e8f0;font-size:11px;}
      tr:nth-child(even){background:#f8fafc;}
      .good{color:#16a34a;font-weight:700;}
      .warn{color:#d97706;font-weight:700;}
      .bad{color:#dc2626;font-weight:700;}
    </style></head><body>
    <h1>VUSAP Lecturer Compliance Report</h1>
    <div class="meta">Victoria University · Exported ${new Date().toLocaleDateString('en-GB')}</div>
    <table>
      <thead><tr><th>Lecturer</th><th>Sessions Held</th><th>Sessions Expected</th><th>Compliance Rate</th></tr></thead>
      <tbody>
        ${data.map(l=>`<tr>
          <td>${l.lecturer}</td>
          <td>${l.sessionsHeld}</td>
          <td>${l.sessionsExpected}</td>
          <td class="${l.complianceRate>=90?'good':l.complianceRate>=80?'warn':'bad'}">${l.complianceRate}%</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <script>window.onload=()=>window.print();<\/script>
    </body></html>`;
    const win = window.open('', '_blank');
    if(win){
      win.document.write(html);
      win.document.close();
    }
    logAuditEvent(State.user?.staffId||'system', State.user?.name||'System', 'Report exported', 'lecturer-compliance', `PDF, ${data.length} lecturers`);
    showToast(`${data.length} lecturer records sent to print`, ICONS.fileText.replace(/width="\d+" height="\d+"/,'width="15" height="15"'));
  }
}

// ============================================================
// ROUTER / NAV / BOOT
// ============================================================

let currentScreen = 'dashboard';

const NAV_CONFIG = {
  lecturer: [
    { id:'dashboard', label:'Dashboard', icon:ICONS.dashboard },
    { id:'markAttendance', label:'Attendance', icon:ICONS.check },
    { id:'schedule', label:'Timetable', icon:ICONS.calendar },
    { id:'register', label:'Students', icon:ICONS.users },
  ],
  registrar: [
    { id:'dashboard', label:'Dashboard', icon:ICONS.dashboard },
    { id:'records', label:'Records', icon:ICONS.records },
    { id:'register', label:'Register', icon:ICONS.users },
    { id:'allSchedules', label:'Schedules', icon:ICONS.schedule },
  ],
  administrator: [
    { id:'dashboard', label:'Dashboard', icon:ICONS.dashboard },
    { id:'register', label:'People', icon:ICONS.users },
    { id:'records', label:'Records', icon:ICONS.records },
    { id:'allSchedules', label:'Schedules', icon:ICONS.schedule },
  ],
  student: [
    { id:'home', label:'Home', icon:ICONS.dashboard },
    { id:'checkin', label:'Check In', icon:ICONS.qrcode },
    { id:'timetable', label:'Timetable', icon:ICONS.calendar },
  ],
};

const DEFAULT_SCREEN = { lecturer:'dashboard', registrar:'dashboard', administrator:'dashboard', student:'home' };

function getScreenHTML(screenId){
  if(State.role === 'lecturer'){
    switch(screenId){
      case 'dashboard': return renderLecturerDashboard();
      case 'markAttendance': return renderMarkAttendance();
      case 'schedule': return renderSchedule({ title:'My Timetable', subtitle:'Weekly timetable overview', backTarget:'dashboard', groupByMode:true });
      case 'register': return renderRegister({ backTarget:'dashboard' });
      case 'startSession': return renderStartSession();
      case 'announcements': return renderAnnouncements();
      case 'sendNotification': return renderComposeNotification();
      case 'sentNotifications': return renderSentNotifications();
      case 'reports': return renderReports();
      // Sept 2026 handoff, Part 4: Lecturer had no records-browsing screen
      // at all before this — reached from a new dashboard quick action
      // ("Attendance Records"), not a bottom-nav tab (the bottom nav is
      // already at 4 tabs).
      case 'attendanceCatalog': return renderAttendanceCatalog();
      case 'courseRecords': return renderCourseRecords();
      case 'notifications': return renderNotifications();
      case 'profile': return renderStaffProfile();
    }
  } else if(State.role === 'registrar'){
    switch(screenId){
      case 'dashboard': return renderRegistrarDashboard();
      // Sept 2026 handoff, Part 4: the "Records" bottom-nav tab now opens
      // the course catalog (courses -> per-student list) instead of one
      // flat list of every scoped record.
      case 'records': return renderAttendanceCatalog();
      case 'courseRecords': return renderCourseRecords();
      case 'register': return renderRegister({ backTarget:'dashboard' });
      case 'allSchedules': return renderSchedule({ title:'All Lecture Schedules', subtitle:'University-wide timetable', showDeptFilter:true, backTarget:'dashboard', showCreateSession:true, groupByMode:true });
      // Sept 2026 handoff (Register/Timetable/Records), Part 2: Registrars can
      // now edit the course catalog too, scoped to their own faculty —
      // previously this screen was Administrator-only even though the
      // Registrar could already create/edit class sessions that reference
      // these same courses.
      case 'courseCatalog': return renderCourseCatalog();
      case 'fraudCenter': return renderFraudCenter();
      case 'reports': return renderReports();
      case 'appeals': return renderAppeals();
      case 'compliance': return renderCompliance();
      case 'dataAnalytics': return renderDataAnalyticsHub();
      case 'analyticsAttendance': return renderStudentAttendanceAnalytics();
      case 'sendNotification': return renderComposeNotification();
      case 'sentNotifications': return renderSentNotifications();
      case 'notifications': return renderNotifications();
      case 'profile': return renderStaffProfile();
    }
  } else if(State.role === 'administrator'){
    switch(screenId){
      case 'dashboard': return renderAdministratorDashboard();
      case 'register': return renderRegister({ backTarget:'dashboard' });
      // Sept 2026 handoff, Part 4: Administrator had no records-browsing
      // screen at all before this — catalogued by faculty, then by course
      // within each faculty (the one role that needs the extra level).
      case 'records': return renderAttendanceCatalog();
      case 'facultyRecordsCatalog': return renderFacultyRecordsCatalog();
      case 'courseRecords': return renderCourseRecords();
      case 'roleAssignments': return renderRoleAssignments();
      case 'facultiesProgrammes': return renderFacultiesProgrammes();
      case 'courseCatalog': return renderCourseCatalog();
      case 'attendancePolicies': return renderAttendancePolicies();
      case 'fraudThresholds': return renderFraudThresholds();
      case 'notifTemplates': return renderNotifTemplates();
      case 'sendNotification': return renderComposeNotification();
      case 'sentNotifications': return renderSentNotifications();
      case 'systemSettings': return renderSystemSettings();
      case 'auditSystem': return renderAuditSystem();
      case 'backups': return renderBackups();
      case 'database': return renderDatabaseManagement();
      case 'allSchedules': return renderSchedule({ title:'All Lecture Schedules', subtitle:'University-wide timetable', showDeptFilter:true, backTarget:'dashboard', showCreateSession:true, groupByMode:true });
      case 'notifications': return renderNotifications();
      case 'profile': return renderStaffProfile();
    }
  } else if(State.role === 'student'){
    switch(screenId){
      case 'home': return renderStudentHome();
      case 'checkin': return renderCheckIn();
      case 'timetable': return renderStudentTimetable();
      case 'profile': return renderStudentProfile();
      case 'announcements': return renderAnnouncements();
      case 'appeals': return renderAppeals();
      case 'notifications': return renderNotifications();
      case 'classSummary': return renderClassSummary();
      case 'missingStudents': return renderMissingStudents();
      case 'classReport': return renderClassReport();
    }
  }
  if(State.role && DEFAULT_SCREEN[State.role] && screenId !== DEFAULT_SCREEN[State.role]){
    console.warn(`getScreenHTML: no case for screenId "${screenId}" under role "${State.role}" — recovering to default screen instead of a dead end.`);
    return getScreenHTML(DEFAULT_SCREEN[State.role]);
  }
  return '<div class="content"><div class="empty-state">Screen not found</div></div>';
}

// ============================================================
// BACK BUTTON / HISTORY INTEGRATION
// ============================================================
// The phone's hardware/gesture back button should behave like the app's own
// back button: step through in-app screens, close open sheets first, and
// only fall through to actually exiting/backgrounding the app once the
// person is on their role's true home screen with nothing else open.

let suppressNextPopstate = false; // set true right before we pop history ourselves (e.g. on logout)

// Shared by every path that can reach getScreenHTML() (navigate(),
// refreshScreenContentOnly(), and any future one) — a single source of
// truth for "does this person still owe a password change," so a future
// new call site can't quietly reintroduce the same bypass we just found
// (refreshScreenContentOnly() had its own inline copy of this check that
// drifted from navigate()'s, and a background fetch calling it right after
// login was enough to bypass the whole gate).
function mustChangePasswordGate(){
  if(!(State.role && State.user)) return false;
  if(State.user.mustChangePassword ?? State.user.must_change_password){
    renderForcedPasswordChange();
    return true;
  }
  return false;
}

function navigate(screenId, opts){
  opts = opts || {};
  // Absolute gate, checked here rather than only at login: no matter what
  // triggered this call — a stale screen id, a defensive recovery, a bug
  // not yet found — someone who still owes a real password can never reach
  // any other screen while this flag is true. This is deliberately blunt
  // (screenId is ignored entirely) because the alternative is trusting
  // every single call site to remember this check individually.
  if(mustChangePasswordGate()) return;
  const previousScreen = currentScreen;
  currentScreen = screenId;
  document.getElementById('screens').innerHTML = `<div class="screen active">${getScreenHTML(screenId)}</div>`;
  renderBottomNav();
  window.scrollTo(0,0);
  const scrollable = document.getElementById('screens').firstElementChild;
  if(scrollable) scrollable.scrollTop = 0;

  // Stop any camera/timer activity tied to the screen we're leaving.
  if(previousScreen === 'startSession' && screenId !== 'startSession') stopSessionTicker();
  if(previousScreen === 'startSession' && screenId !== 'startSession') stopRosterPolling();
  if(previousScreen === 'checkin' && screenId !== 'checkin') stopQrScanner();
  // home<->checkin transitions deliberately don't reset the sync guard —
  // the discovered LIVE_SESSION state is equally valid on either screen, no
  // need to re-fetch just for switching between them. Leaving to anywhere
  // else resets it, so returning later triggers a fresh discovery rather
  // than trusting a potentially-stale state from whenever it was last checked.
  if(previousScreen === 'checkin' && screenId !== 'checkin' && screenId !== 'home') resetStudentLiveSync();
  if(previousScreen === 'home' && screenId !== 'home' && screenId !== 'checkin') resetStudentLiveSync();
  if(previousScreen === 'home' && screenId !== 'home') stopStudentBannerTicker();
  if(screenId !== 'startSession' && screenId !== 'checkin') removeLiveDebugPanel();
  // The analytics canvases get torn down and replaced every time this
  // screen is (re-)entered — destroy the previous Chart.js instances first
  // so a returning visit doesn't hit "Canvas is already in use".
  if(previousScreen === 'analyticsAttendance' && screenId !== 'analyticsAttendance') destroyAnalyticsCharts();

  // Start activity tied to the screen we're entering.
  if(screenId === 'startSession'){
    drawQrPlaceholder();
    startSessionTicker();
    startRosterPolling();
    updateLiveCheckinCount(); // Gate 4: show a real count immediately, don't wait for the first tick
    updateLiveRoster();
    updateDebugPanel();
  }
  if(screenId === 'checkin'){
    startStudentLiveSessionSync();
    updateDebugPanel();
  }
  if(screenId === 'home'){
    startStudentBannerTicker();
    // The banner now depends on knowing the real live-session state
    // (isLiveSessionOpenForStudent()) — without this, a student who lands
    // on Home after a reload without ever visiting Check-In first would
    // never trigger discovery, leaving LIVE_SESSION at stale defaults and
    // hasCheckedInToday unrestored. That produced exactly this bug: a
    // student who already checked in would see the naive time-based "late"
    // warning instead of "You're checked in", since getStudentBannerLecture()
    // has no way to know they'd already checked in without this running first.
    startStudentLiveSessionSync();
  }
  if(screenId === 'checkin' && checkinMethod === 'qr' && isLiveSessionActive() && !State.hasCheckedInToday) startQrScanner();
  // Restored — this was dropped from a prior build of the Lecturer Dashboard
  // (a genuine regression caught during this session's review). Without it,
  // a Lecturer who already has a session running and reloads (or navigates
  // back to Dashboard) would see "Start Live Session" instead of "Current
  // Session", since nothing re-checks reality on Dashboard entry.
  if(screenId === 'dashboard' && State.role === 'lecturer') checkLecturerActiveSession();
  if(screenId === 'register') loadProvisionedAccountsFromSupabase();
  if(screenId === 'sendNotification'){ updateComposeNotificationFields('allStudents'); updateNotifPreview(); }
  // Charts need their <canvas> elements in the DOM first, which only
  // happens after the innerHTML assignment above — safe to call synchronously
  // here since this isn't a fetch, just reading the just-inserted DOM.
  if(screenId === 'analyticsAttendance') renderStudentAnalyticsCharts();
  // Login-time fetch only catches messages sent before this session started —
  // re-fetch on every visit to the inbox so messages sent mid-session (the
  // Admin/Lecturer/Registrar composing while this device stays logged in)
  // actually show up without requiring a full logout/login.
  if(screenId === 'notifications') loadNotificationsFromSupabase();
  if(screenId === 'sentNotifications') loadSentNotificationsFromSupabase();
  if(screenId === 'auditSystem') loadAuditLogFromSupabase();
  if(screenId === 'fraudCenter') loadSuspicionLogFromSupabase();
  if(screenId === 'appeals') loadAppealsFromSupabase();

  if(!opts.fromPopstate){
    const state = { vusapScreen: screenId, vusapRole: State.role };
    if(opts.replace){
      history.replaceState(state, '', '');
    } else {
      history.pushState(state, '', '');
    }
  }
}

function rerenderCurrentScreen(){
  navigate(currentScreen, { replace: true });
}

// Updates the visible screen's HTML directly, WITHOUT going through
// navigate() — meaning none of navigate()'s side-effect hooks re-fire.
// Use this (not rerenderCurrentScreen()) whenever a background fetch needs
// to refresh what's on screen and that same fetch was itself triggered by
// one of navigate()'s hooks — otherwise: hook fires fetch, fetch resolves
// and calls rerenderCurrentScreen(), which calls navigate() again, which
// re-fires the same hook, forever. (This is exactly what caused the
// Notifications screen to flicker continuously — fixed by switching its
// load function to this instead.)
function refreshScreenContentOnly(){
  // Same gate as navigate() — see mustChangePasswordGate()'s comment for
  // why this needs its own explicit check rather than trusting navigate()
  // alone to cover every path.
  if(mustChangePasswordGate()) return;
  const screensEl = document.getElementById('screens');
  if(!screensEl || !currentScreen) return;
  screensEl.innerHTML = `<div class="screen active">${getScreenHTML(currentScreen)}</div>`;
}

// Wrap openSheet/closeSheet so an open sheet consumes one "back" step,
// matching native Android/iOS sheet behavior (back closes the sheet, not the screen).
const _openSheetBase = openSheet;
const _closeSheetBase = closeSheet;
let openSheetId = null;

openSheet = function(id){
  _openSheetBase(id);
  openSheetId = id;
  history.pushState({ vusapSheet: id }, '', '');
};

closeSheet = function(id){
  _closeSheetBase(id);
  if(openSheetId === id){
    openSheetId = null;
    // This close did NOT come from a back-button press (those are handled
    // directly in the popstate listener below and never reach this branch
    // while openSheetId is still set). So the sheet's history entry is still
    // sitting on the stack — pop it now so back-button accounting stays in
    // sync with what's actually on screen.
    suppressNextPopstate = true;
    history.back();
  }
  resetSheetContentIfNeeded(id);
};

window.addEventListener('popstate', (event)=>{
  if(suppressNextPopstate){
    suppressNextPopstate = false;
    return;
  }

  // If a sheet is open, the back gesture closes it and we're done — the
  // history entry for the sheet has already been consumed by the browser.
  if(openSheetId){
    const closedSheetId = openSheetId;
    _closeSheetBase(openSheetId);
    openSheetId = null;
    resetSheetContentIfNeeded(closedSheetId);
    return;
  }

  const state = event.state;
  if(state && state.vusapScreen && State.role){
    navigate(state.vusapScreen, { fromPopstate: true });
    return;
  }
  if(state && state.vusapAuthScreen){
    renderAuthScreenFromHistory(state.vusapAuthScreen);
    return;
  }
  if(state && state.vusapScreen === null){
    // The login-screen floor, set by renderApp()'s replaceState. Reaching it
    // via back navigation means abandoning whatever auth flow was in
    // progress (forced password change, forgot-password, etc) — clear any
    // half-set session state so renderApp() actually shows the login form
    // instead of re-entering a dashboard with a stale State.role.
    State.role = null;
    State.user = null;
    State.pendingUserId = null;
    renderApp();
    return;
  }
  // If there's no app state left to pop to (state is null/undefined), we let
  // the browser's default behavior proceed — this is the true home boundary,
  // where back should exit/background the PWA rather than do anything in-app.
});

// Pre-login auth screens (forgot password, forced password change) live outside
// the normal navigate()/NAV_CONFIG system since there's no role/bottom-nav yet.
// They still need a history entry each so the hardware back button steps
// through them sensibly instead of doing nothing.
function pushAuthScreenState(name){
  history.pushState({ vusapAuthScreen: name }, '', '');
}

function renderAuthScreenFromHistory(name){
  if(name === 'login'){ renderApp(); return; }
  if(name === 'forgotRequest'){ renderForgotPasswordRequest({ fromPopstate: true }); return; }
  if(name === 'forcedChange'){
    // Stepping "back" out of a forced password change just signs the person
    // back out — they can't skip setting a real password by going back.
    logout();
    return;
  }
  // forgotSent / resetForm depend on transient state (passwordResetTarget) that
  // a real back navigation shouldn't try to resurrect — safest is the login screen.
  renderApp();
}

function renderBottomNav(){
  const items = NAV_CONFIG[State.role] || [];
  const nav = document.getElementById('bottomNav');
  nav.innerHTML = items.map(item=>`
    <button class="nav-item ${currentScreen===item.id?'active':''}" onclick="navigate('${item.id}')">
      ${item.icon}
      <span>${item.label}</span>
    </button>`).join('');
}

function renderApp(){
  const app = document.getElementById('app');
  const screensEl = document.getElementById('screens');
  const navEl = document.getElementById('bottomNav');

  if(!State.role){
    app.removeAttribute('data-role');
    screensEl.innerHTML = renderLogin();
    setTimeout(checkBackendStatus, 100); // let the DOM settle before the fetch
    navEl.innerHTML = '';
    navEl.style.display = 'none';
    // Anchor history here so a stray back-press after logout can't resurrect
    // a previous session's screen underneath the login form.
    history.replaceState({ vusapScreen: null }, '', '');
    return;
  }
  navEl.style.display = 'flex';
  app.setAttribute('data-role', State.role);
  currentScreen = DEFAULT_SCREEN[State.role] || 'dashboard';
  // Replace (not push) so this home screen becomes the back-button floor —
  // pressing back here falls through to exiting/backgrounding the app.
  navigate(currentScreen, { replace: true });
}

let _autoLogoutTimer = null;
function resetAutoLogoutTimer(){
  clearTimeout(_autoLogoutTimer);
  const ms = (SYSTEM_SETTINGS.autoLogoutMinutes || 30) * 60 * 1000;
  _autoLogoutTimer = setTimeout(()=>{
    if(State.role){
      logout();
      showToast("You were logged out due to inactivity.");
    }
  }, ms);
}

function boot(){
  // attach a pseudo-id to user object for display purposes
  if(State.user && !State.user.id){
    const idKey = Object.keys(USERS).find(k=>USERS[k]===State.user);
    State.user.id = idKey;
  }
  renderApp();
  showToast(`Welcome, ${firstName(State.user.name)}`);
  resetAutoLogoutTimer();
  ['click','keydown','touchstart'].forEach(ev => {
    document.addEventListener(ev, resetAutoLogoutTimer, { passive: true });
  });
}

// close sheet on overlay tap
document.addEventListener('DOMContentLoaded', ()=>{
  // Initialize theme on app load
  initializeTheme();

  document.getElementById('sheetOverlay').addEventListener('click', ()=>{
    if(openSheetId){
      closeSheet(openSheetId);
    } else {
      document.querySelectorAll('.sheet.show').forEach(s=>s.classList.remove('show'));
      document.getElementById('sheetOverlay').classList.remove('show');
    }
  });
  // Attempt to resume a Supabase session first (e.g. after a page refresh,
  // or when the user follows a password-reset link back into the app).
  // resumeSupabaseSession() calls boot() directly when a session is found,
  // and resolves quietly without doing anything when there isn't one —
  // renderApp() then shows the login screen as normal.
  // Fetch live Faculties & Programmes in the background (Gate 4). Fire-and-
  // forget: it silently keeps mock data on failure, and since every screen
  // reads FACULTIES/PROGRAMMES fresh on each render, a later-resolving fetch
  // just takes effect on the next render with no extra wiring needed.
  loadFacultiesAndProgrammesFromSupabase();
  // Gate 6: live STUDENTS loader — merges live student accounts into the
  // existing mock roster (see the function itself for why merge, not
  // replace: with only a handful of real accounts so far, a full replace
  // would shrink the visible roster from hundreds down to a handful the
  // moment this succeeds, which is never what should happen silently).
  loadStudentsFromSupabase();
  // Gate 6: live timetable_slots loader — same merge philosophy as
  // STUDENTS, for the same reason: the mock SCHEDULE baseline stays as
  // fallback/coexisting data rather than being wiped by a handful of real
  // slots the moment they exist.
  loadTimetableFromSupabase();

  resumeSupabaseSession().then(() => {
    if(!State.role) renderApp(); // no session found — show login
  });
  registerServiceWorker();
  setupInstallPrompt();
});

// ============================================================
// PWA: SERVICE WORKER + INSTALL PROMPT
// ============================================================

function registerServiceWorker(){
  if('serviceWorker' in navigator){
    window.addEventListener('load', ()=>{
      navigator.serviceWorker.register('sw.js').catch(()=>{ /* offline-safe no-op */ });
    });
  }
}

let deferredInstallPrompt = null;

function setupInstallPrompt(){
  window.addEventListener('beforeinstallprompt', (e)=>{
    e.preventDefault();
    deferredInstallPrompt = e;
    const banner = document.getElementById('installBanner');
    if(banner) banner.classList.add('show');
  });
}

function triggerInstall(){
  if(deferredInstallPrompt){
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.finally(()=>{
      deferredInstallPrompt = null;
      const banner = document.getElementById('installBanner');
      if(banner) banner.classList.remove('show');
    });
  }
}

function dismissInstallBanner(){
  const banner = document.getElementById('installBanner');
  if(banner) banner.classList.remove('show');
}
