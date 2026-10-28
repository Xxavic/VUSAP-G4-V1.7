"""Behaviour checks for the features most likely to regress: device layout,
backup PIN, calendar save, and the student session re-check."""
from helpers import *

def layout(url):
    print('layout: device recognition')
    cases = [
        ('desktop 1366', dict(viewport=(1366, 768)), True),
        ('desktop 800 wide (phone layout)', dict(viewport=(800, 700)), None),
        ('phone', dict(viewport=(390, 800), has_touch=True, is_mobile=True, screen={'width': 390, 'height': 800}), False),
        ('phone in desktop-site mode', dict(viewport=(1280, 700), has_touch=True, is_mobile=True, screen={'width': 412, 'height': 915}), False),
        ('tablet landscape', dict(viewport=(1180, 820), has_touch=True, is_mobile=True), True),
    ]
    for name, kw, expect in cases:
        vp = kw.pop('viewport')
        with page(url, viewport=vp, splash=False, **kw) as pg:
            for role in ('administrator', 'lecturer', 'student'):
                got = pg.evaluate("(r)=>{State.role=r;State.user=%s[r];renderApp();return document.body.classList.contains('wide-shell')}" % __import__('json').dumps(USERS), role)
                if expect is None:
                    continue
                check(f'{name} / {role}: wide layout = {expect}', got == expect, f'got {got}')

def backup_pin(url):
    print('backup PIN')
    with page(url, splash=False) as pg:
        r = pg.evaluate("""()=>{
          State.role='lecturer';State.user={name:'L',staffId:'L1',id:'L1'};renderApp();navigate('startSession',{replace:true});
          const out={}; const html=()=>document.getElementById('pinBlock').innerHTML;
          out.hidden=!html().includes('session-pin-digit');
          const p0=LIVE_SESSION.pin; generateBackupPin(); const p1=LIVE_SESSION.pin;
          out.shown=html().includes('session-pin-digit')&&document.getElementById('pinBlock').textContent.includes(p1);
          out.newPin=p0!==p1; out.audit=AUDIT_LOG[0].action==='Backup PIN generated';
          pinShownUntil=Date.now()-1; tickBackupPin();
          out.expires=!html().includes('session-pin-digit')&&LIVE_SESSION.pin!==p1;
          generateBackupPin(); const p2=LIVE_SESSION.pin; hideBackupPin(); out.hideRotates=LIVE_SESSION.pin!==p2&&!backupPinActive();
          return out}""")
        check('PIN is hidden until the lecturer asks', r['hidden'])
        check('generating shows a fresh PIN', r['shown'] and r['newPin'])
        check('generating is written to the audit log', r['audit'])
        check('an expired PIN is replaced by an unseen one', r['expires'])
        check('Hide now rotates the PIN', r['hideRotates'])
        check('no page errors', not pg.errors, '; '.join(pg.errors)[:200])

def calendar(url):
    print('calendar save')
    with page(url, splash=False) as pg:
        r = pg.evaluate("""async()=>{
          State.role='administrator';State.user={name:'G',staffId:'VU-ADM-001',id:'VU-ADM-001'};renderApp();
          const UUID='11111111-2222-3333-4444-555555555555'; const calls=[]; let mode='ok';
          const qb=()=>({insert(row){calls.push(row);this.row=row;return this},select(){return this},single:async function(){
            if(mode==='missing') return {data:null,error:{code:'PGRST205',message:'Could not find the table in the schema cache'}};
            if(!/^[0-9a-f-]{36}$/.test(this.row.created_by||'')) return {data:null,error:{code:'22P02',message:'invalid uuid'}};
            return {data:{id:'row1'},error:null}}});
          SUPABASE_CLIENT={from:()=>qb(),auth:{getSession:async()=>({data:{session:{user:{id:UUID}}}})}}; LIVE_BACKEND=true;
          navigate('academicCalendar');
          const set=(id,v)=>{const e=document.getElementById(id); if(e) e.value=v};
          const fill=()=>{set('calKind','exam');set('calTitle','Exam Period');set('calStart','2026-11-02');set('calEnd','2026-11-20')};
          fill(); const n0=ACADEMIC_CALENDAR.length; await addCalendarEvent();
          return {saved:ACADEMIC_CALENDAR.length===n0+1, uuid:calls[0].created_by===UUID}}""")
        check('calendar entry saves', r['saved'])
        check('calendar sends the auth user id (uuid), not the university id', r['uuid'])

def recheck(url):
    print('student session re-check (takes ~40s)')
    with page(url, viewport=(390, 800), splash=False, has_touch=True, is_mobile=True, screen={'width': 390, 'height': 800}) as pg:
        r = pg.evaluate("""async()=>{
          const wait=ms=>new Promise(r=>setTimeout(r,ms));
          State.role='student';State.user={name:'A',reg:'VU-X',id:'VU-X',mode:'day',supabaseId:'u1'};
          let live=false,queries=0,inflight=0,maxInflight=0,delay=0,lastIn=null;
          const row={id:'b1',course_code:STUDENT_COURSES[0].code,course_name:'DS',room:'LT1',mode:'day',active:true,started_at:new Date().toISOString(),window_seconds:600,token_rotate_seconds:30,pin:null,token:null,coordinator_authorized:false,class_id:null};
          const qb=(t)=>{const q={select(){return q},in(c,v){lastIn=v;return q},eq(){return q},order(){return q},limit:async()=>{if(t==='live_qr_sessions'){queries++;inflight++;maxInflight=Math.max(maxInflight,inflight);await wait(delay);inflight--}return {data:live?[row]:[],error:null}},maybeSingle:async()=>({data:null,error:null})};return q};
          SUPABASE_CLIENT={from:(t)=>qb(t),channel:()=>({on(){return this},subscribe(){return this}}),removeChannel(){},auth:{getSession:async()=>({data:{session:null}})}};
          LIVE_BACKEND=true; LIVE_SESSION.liveSessionId=null;
          const hh=d=>String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
          const lectureAt=(o,len)=>{const s=new Date(Date.now()+o*60000),e=new Date(s.getTime()+len*60000);return [{code:STUDENT_COURSES[0].code,name:'DS',room:'LT1',time:hh(s)+'–'+hh(e)}]};
          const out={};
          renderApp(); getStudentTodayLectures=()=>[]; navigate('home'); await wait(300);
          out.oneQuery=queries===1&&lastIn.length===STUDENT_COURSES.length;
          queries=0; await wait(7000); out.quietOutside=queries===0;
          getStudentTodayLectures=()=>lectureAt(10,60); out.windowIn=inStudentLectureWindow();
          getStudentTodayLectures=()=>lectureAt(40,60); out.windowFar=!inStudentLectureWindow();
          getStudentTodayLectures=()=>lectureAt(-90,60); out.windowAfter=!inStudentLectureWindow();
          getStudentTodayLectures=()=>lectureAt(10,60); queries=0; await wait(6500); out.polls=queries>=1;
          Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'hidden'});
          queries=0; await wait(7000); out.quietHidden=queries===0;
          Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'visible'});
          delay=9000; maxInflight=0; await wait(14000); out.noOverlap=maxInflight<=1;
          delay=0; live=true; await wait(16000); out.found=isLiveSessionOpenForStudent();
          queries=0; await wait(7000); out.stops=queries===0;
          return out}""")
        for k, label in [('oneQuery', 'one query covers all courses'), ('quietOutside', 'no polling outside a lecture window'),
                         ('windowIn', 'window opens 15 min before a lecture'), ('windowFar', 'window closed when lecture is far off'),
                         ('windowAfter', 'window closed after the lecture'), ('polls', 'polls inside the window'),
                         ('quietHidden', 'no polling while the app is hidden'), ('noOverlap', 'a slow check never overlaps the next'),
                         ('found', 'finds a session that starts late'), ('stops', 'stops polling once found')]:
            check(label, r[k])

if __name__ == '__main__':
    import sys
    quick = '--quick' in sys.argv
    with site() as url:
        layout(url); backup_pin(url); calendar(url)
        if not quick: recheck(url)
    finish()
