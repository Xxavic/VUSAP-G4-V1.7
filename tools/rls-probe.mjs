// Anonymous read probe. Run:  node tools/rls-probe.mjs
//
// Asks Supabase for one row from each table WITHOUT signing in, exactly as a
// stranger holding the public key from client-config.js could. It only reads;
// it changes nothing. Any table that answers 200 with rows is readable by
// anyone on the internet.
//
// The URL and key are read from client-config.js next to app.js, so nothing
// needs pasting anywhere.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'client-config.js'), 'utf8');
const win = {};
new Function('window', src)(win);
const cfg = win.QRAST_CLIENT || {};
if(!cfg.supabaseUrl || !cfg.supabaseAnon){ console.error('client-config.js has no Supabase settings.'); process.exit(2); }

const TABLES = ['users','faculties','programmes','classes','enrollments','attendance','attendance_appeals',
  'sessions','timetable_slots','live_qr_sessions','live_qr_secrets','fraud_logs','audit_log','notifications',
  'announcements','support_tickets','account_deletion_requests','academic_calendar_events','academic_year_archives',
  'course_attendance_caps','system_settings','rate_limits','checkin_attempts'];

let exposed = 0;
console.log('table'.padEnd(28) + 'anonymous read');
for(const t of TABLES){
  let line;
  try{
    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${t}?select=*&limit=1`, {
      headers: { apikey: cfg.supabaseAnon, Authorization: `Bearer ${cfg.supabaseAnon}`, Prefer: 'count=exact' },
    });
    const range = res.headers.get('content-range') || '';
    const total = range.includes('/') ? range.split('/')[1] : '?';
    if(res.status === 200){
      const rows = await res.json();
      if(rows.length){ line = `EXPOSED  (${total} rows readable)`; exposed++; }
      else line = 'ok, empty or filtered (RLS may be hiding rows)';
    } else if(res.status === 404 || res.status === 400) line = 'not found / not exposed';
    else if(res.status === 401 || res.status === 403) line = 'blocked';
    else line = `HTTP ${res.status}`;
  } catch(e){ line = 'network error: ' + e.message; }
  console.log(t.padEnd(28) + line);
}
console.log(exposed ? `\n${exposed} table(s) readable without signing in. Run tools/rls-audit.sql next.` : '\nNo table returned rows to an anonymous caller.');
process.exit(exposed ? 1 : 0);
