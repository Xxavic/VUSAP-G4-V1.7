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
        r = pg.evaluate("""async()=>{
          State.role='lecturer';State.user={name:'L',staffId:'L1',id:'L1'};renderApp();navigate('startSession',{replace:true});
          const out={}; const html=()=>document.getElementById('pinBlock').innerHTML;
          out.hidden=!html().includes('session-pin-digit');
          const p0=LIVE_SESSION.pin; await generateBackupPin(); const p1=LIVE_SESSION.pin;
          out.shown=html().includes('session-pin-digit')&&document.getElementById('pinBlock').textContent.includes(p1);
          out.newPin=p0!==p1; out.audit=AUDIT_LOG[0].action==='Backup PIN generated';
          pinShownUntil=Date.now()-1; tickBackupPin();
          out.expires=!html().includes('session-pin-digit')&&LIVE_SESSION.pin!==p1;
          await generateBackupPin(); const p2=LIVE_SESSION.pin; hideBackupPin(); out.hideRotates=LIVE_SESSION.pin!==p2&&!backupPinActive();

          // With a live backend: the server is asked, and only an accepted code is shown.
          LIVE_BACKEND=true; LIVE_SESSION.liveSessionId='b-1'; backupPinRpcAvailable=null;
          const calls=[]; let reply={data:{ok:true},error:null};
          SUPABASE_CLIENT={rpc:async(name,args)=>{calls.push([name,args]);return reply}, from:()=>({upsert:async()=>({}),update(){return this},eq:async()=>({}),insert:async()=>({})})};
          reply={data:{ok:true},error:null}; await generateBackupPin();
          out.rpcCalled=calls.length>=1&&calls[0][0]==='set_backup_pin'&&calls[0][1].p_seconds===BACKUP_PIN_SECONDS&&/^[0-9]{6}$/.test(calls[0][1].p_pin);
          out.shownAfterOk=backupPinActive()&&LIVE_SESSION.pin===calls[0][1].p_pin;
          hideBackupPin(); await new Promise(r=>setTimeout(r,50));
          const last=calls[calls.length-1]; out.hideRetires=last[0]==='set_backup_pin'&&last[1].p_seconds===0;
          reply={data:{ok:false,reason:'not_owner'},error:null}; await generateBackupPin(); out.rejectedNotShown=!backupPinActive();
          reply={data:null,error:{message:'Failed to fetch'}}; await generateBackupPin(); out.networkNotShown=!backupPinActive();
          reply={data:null,error:{code:'PGRST202',message:'Could not find the function public.set_backup_pin in the schema cache'}};
          await generateBackupPin(); out.fallsBackWhenMigrationMissing=backupPinActive();
          return out}""")
        check('PIN is hidden until the lecturer asks', r['hidden'])
        check('generating shows a fresh PIN', r['shown'] and r['newPin'])
        check('generating is written to the audit log', r['audit'])
        check('an expired PIN is replaced by an unseen one', r['expires'])
        check('Hide now rotates the PIN', r['hideRotates'])
        check('server is asked to set the PIN with the 2-minute lifetime', r['rpcCalled'])
        check('the code is shown once the server accepts it', r['shownAfterOk'])
        check('Hide now retires the code on the server (lifetime 0)', r['hideRetires'])
        check('a code the server refuses is not shown', r['rejectedNotShown'])
        check('a code is not shown when the server cannot be reached', r['networkNotShown'])
        check('falls back to device-side expiry if the migration is not run', r['fallsBackWhenMigrationMissing'])
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
          const qb=(t)=>{const q={select(){return q},in(c,v){lastIn=v;return q},eq(){return q},gte(){return q},lt(){return q},order(){return q},limit:async()=>{if(t==='live_qr_sessions'){queries++;inflight++;maxInflight=Math.max(maxInflight,inflight);await wait(delay);inflight--}return {data:live?[row]:[],error:null}},maybeSingle:async()=>({data:null,error:null})};q.then=(res,rej)=>q.limit().then(res,rej);return q};
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
          Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'hidden'});Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
          queries=0; await wait(7000); out.quietHidden=queries===0;
          Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'visible'});Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});
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

def quick_messages(url):
    print('quick messages persist')
    with page(url, splash=False) as pg:
        r = pg.evaluate("""async()=>{
          const wait=ms=>new Promise(r=>setTimeout(r,ms));
          State.role='administrator';State.user={name:'G',staffId:'VU-ADM-001',id:'VU-ADM-001'};renderApp();
          const UUID='11111111-2222-3333-4444-555555555555';
          let table=[{id:'u1',label:'From DB',title:'T',body:'B'}]; let missing=false, failNext=null; const calls=[];
          const qb=()=>{let op='select', payload=null, filt=null;
            const q={select(){return q},order(){return q},eq(c,v){filt=v;return q},
              insert(row){op='insert';payload=row;return q},update(row){op='update';payload=row;return q},delete(){op='delete';return q},single(){return q},
              then(res,rej){return (async()=>{
                calls.push([op,payload,filt]);
                if(missing) return {data:null,error:{code:'PGRST205',message:'schema cache'}};
                if(failNext){const e=failNext;failNext=null;return {data:null,error:e}}
                if(op==='select') return {data:table,error:null};
                if(op==='insert'){const row={id:'new1',...payload};table.push(row);return {data:{id:'new1'},error:null}}
                if(op==='update'){const t=table.find(x=>x.id===filt);Object.assign(t,payload);return {data:[{id:filt}],error:null}}
                if(op==='delete'){table=table.filter(x=>x.id!==filt);return {data:[{id:filt}],error:null}}
              })().then(res,rej)}};
            return q};
          SUPABASE_CLIENT={from:(t)=>t==='quick_messages'?qb():{insert:async()=>({}),select(){return this},order(){return this},limit:async()=>({data:[],error:null}),eq(){return this},update(){return this},upsert:async()=>({})},auth:{getSession:async()=>({data:{session:{user:{id:UUID}}}})}}; LIVE_BACKEND=true;
          const out={};
          const defaults=QUICK_MESSAGES.length;
          navigate('notifTemplates'); await wait(300);
          out.loaded=QUICK_MESSAGES.length===1&&QUICK_MESSAGES[0].label==='From DB'&&quickMessagesLive;
          const set=(id,v)=>{const e=document.getElementById(id); if(e) e.value=v};
          openQuickMessageSheet(null); set('qmLabel','New one');set('qmTitle','Hello [x]');set('qmBody','Body [x]');
          await saveQuickMessage(null); await wait(200);
          const ins=calls.find(c=>c[0]==='insert');
          out.insertsWithAuthUuid=!!ins&&ins[1].created_by===UUID&&ins[1].label==='New one';
          out.addedLocally=QUICK_MESSAGES.some(q=>q.id==='new1');
          failNext={code:'42501',message:'rls'}; openQuickMessageSheet(null); set('qmLabel','Nope');set('qmTitle','t');set('qmBody','b');
          await saveQuickMessage(null); out.refusedNotAdded=!QUICK_MESSAGES.some(q=>q.label==='Nope');
          await deleteQuickMessage('new1'); await deleteQuickMessage('new1'); await wait(200);
          out.deleted=!QUICK_MESSAGES.some(q=>q.id==='new1')&&table.every(x=>x.id!=='new1');
          missing=true; quickMessagesLive=false; QUICK_MESSAGES.splice(0,QUICK_MESSAGES.length,{id:'qm1',label:'Built-in',title:'t',body:'b'});
          const ok=await loadQuickMessagesFromSupabase();
          out.fallsBackWhenNoTable=ok===false&&QUICK_MESSAGES.length===1&&QUICK_MESSAGES[0].label==='Built-in'&&!quickMessagesLive;
          return out}""")
        for k, label in [('loaded', 'messages are loaded from the database'), ('insertsWithAuthUuid', 'a new message is saved with the auth user id'),
                         ('addedLocally', 'it appears in the list'), ('refusedNotAdded', 'a refused save is not added'),
                         ('deleted', 'delete removes it from the database and the list'),
                         ('fallsBackWhenNoTable', 'built-in messages are kept if the table is missing')]:
            check(label, r[k])
        check('no page errors', not pg.errors, '; '.join(pg.errors)[:200])

def realtime(url):
    print('student realtime (no polling while connected)')
    with page(url, viewport=(390, 800), splash=False, has_touch=True, is_mobile=True, screen={'width': 390, 'height': 800}) as pg:
        r = pg.evaluate("""async()=>{
          const wait=ms=>new Promise(r=>setTimeout(r,ms));
          State.role='student';State.user={name:'A',reg:'VU-X',id:'VU-X',mode:'day',supabaseId:'u1'};
          let queries=0, handler=null, statusCb=null, channels=[], filters=[];
          const mk=(extra)=>({course_code:STUDENT_COURSES[0].code,course_name:'DS',room:'LT1',mode:'day',active:true,started_at:new Date().toISOString(),window_seconds:600,token_rotate_seconds:30,pin:null,token:null,coordinator_authorized:false,class_id:null,...extra});
          const qb=(t)=>{const q={select(){return q},in(){return q},eq(){return q},gte(){return q},lt(){return q},order(){return q},limit:async()=>{if(t==='live_qr_sessions')queries++;return {data:[],error:null}},maybeSingle:async()=>({data:null,error:null})};q.then=(res,rej)=>q.limit().then(res,rej);return q};
          SUPABASE_CLIENT={from:(t)=>qb(t),
            channel:(name)=>{channels.push(name);const ch={on(ev,opts,cb){filters.push(opts.filter);handler=cb;return ch},subscribe(cb){statusCb=cb;return ch}};return ch},
            removeChannel(){},auth:{getSession:async()=>({data:{session:null}})}};
          LIVE_BACKEND=true; LIVE_SESSION.liveSessionId=null; studentRealtimeStatus='off';
          let redraws=0; const origRefresh=refreshScreenContentOnly; refreshScreenContentOnly=()=>{redraws++;return origRefresh()};
          const hh=d=>String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
          getStudentTodayLectures=()=>{const s=new Date(Date.now()+10*60000),e=new Date(s.getTime()+3600000);return [{code:STUDENT_COURSES[0].code,name:'DS',room:'LT1',time:hh(s)+'–'+hh(e)}]};
          const out={};
          renderApp(); navigate('home'); await wait(300);
          out.subscribedOnce = channels.length===1 && channels[0]==='live-qr-student';
          out.filterCoversCourses = filters[0].startsWith('course_code=in.(') && STUDENT_COURSES.every(c=>filters[0].includes(c.code));
          out.notOpenYet = !isLiveSessionOpenForStudent();
          // connected: the catch-up check runs once, then polling stays silent
          statusCb('SUBSCRIBED'); await wait(300); queries=0; await wait(7000);
          out.silentWhileConnected = queries===0;
          // other mode / other course are ignored
          handler({new:mk({id:'x1',mode:'evening'})}); out.ignoresOtherMode = !isLiveSessionOpenForStudent();
          handler({new:mk({id:'x2',course_code:'ZZZ999'})}); out.ignoresOtherCourse = !isLiveSessionOpenForStudent();
          // our session starts: picked up instantly, with no query
          queries=0; handler({new:mk({id:'b1'})}); await wait(100);
          out.opensInstantly = isLiveSessionOpenForStudent() && queries===0 && LIVE_SESSION.liveSessionId==='b1';
          const before=redraws; handler({new:mk({id:'b1',token:'T2'})}); handler({new:mk({id:'b1',token:'T3'})});
          out.rotationsDoNotRedraw = redraws===before;
          // it ends: closes
          handler({new:mk({id:'b1',active:false})}); out.closesOnEnd = !isLiveSessionOpenForStudent();
          // connection lost: polling resumes as the fallback
          LIVE_SESSION.liveSessionId=null; statusCb('CHANNEL_ERROR'); queries=0; await wait(6800);
          out.pollsWhenDown = queries>=1;
          return out}""")
        for k, label in [('subscribedOnce', 'one subscription is opened'), ('filterCoversCourses', 'it covers every enrolled course'),
                         ('notOpenYet', 'nothing is shown before a session exists'), ('silentWhileConnected', 'no polling while connected'),
                         ('ignoresOtherMode', 'ignores the other Day/Evening mode'), ('ignoresOtherCourse', 'ignores a course the student is not in'),
                         ('opensInstantly', 'a started session appears at once with no query'), ('rotationsDoNotRedraw', 'QR rotations do not redraw the screen'),
                         ('closesOnEnd', 'an ended session closes the check-in'), ('pollsWhenDown', 'polling resumes when the connection is lost')]:
            check(label, r[k])
        check('no page errors', not pg.errors, '; '.join(pg.errors)[:200])

def a11y(url):
    print('keyboard and print')
    with page(url, splash=False) as pg:
        r = pg.evaluate("""async()=>{
          State.role='lecturer';State.user=%s;renderApp();
          const wait=ms=>new Promise(r=>setTimeout(r,ms)); const out={};
          document.body.insertAdjacentHTML('beforeend','<div class="sheet" id="tSheet"><input id="tIn"><button id="tB">x</button></div><button id="opener">o</button>');
          const op=document.getElementById('opener'); op.focus();
          out.hiddenWhenClosed = getComputedStyle(document.getElementById('tSheet')).visibility==='hidden';
          openSheet('tSheet'); await wait(400);
          out.opens = document.getElementById('sheetOverlay').classList.contains('show');
          out.focusInside = document.getElementById('tSheet').contains(document.activeElement);
          out.visibleWhenOpen = getComputedStyle(document.getElementById('tSheet')).visibility==='visible';
          document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); await wait(100);
          out.escCloses = !document.getElementById('sheetOverlay').classList.contains('show') && !document.getElementById('tSheet').classList.contains('show');
          out.focusReturns = document.activeElement===op;
          return out}""" % __import__('json').dumps(USERS['lecturer']))
        for k, label in [('hiddenWhenClosed', 'a closed sheet is out of the tab order'), ('opens', 'a sheet opens'),
                         ('focusInside', 'focus moves into the sheet'), ('visibleWhenOpen', 'an open sheet is visible'),
                         ('escCloses', 'Esc closes the sheet'), ('focusReturns', 'focus returns to the opener')]:
            check(label, r[k])
        pg.evaluate("()=>{document.getElementById('opener').remove();document.getElementById('tSheet').remove();document.activeElement.blur()}")
        pg.keyboard.press('Tab')
        ring = pg.evaluate("()=>{const e=document.activeElement;const cs=getComputedStyle(e);return e!==document.body && cs.outlineStyle!=='none' && parseFloat(cs.outlineWidth)>0}")
        check('Tab shows a focus ring', ring)
        pg.emulate_media(media='print')
        hidden = pg.evaluate("()=>['bottomNav','sheetOverlay'].every(i=>{const e=document.getElementById(i);return !e||getComputedStyle(e).display==='none'})")
        check('print hides navigation', hidden)
        check('no page errors', not pg.errors, '; '.join(pg.errors)[:200])

def location_check(url):
    print('location check (flag only, off by default)')
    SETUP = """()=>{ window.__rpc=[]; window.__upserts=[]; LIVE_BACKEND=true;
      SUPABASE_CLIENT={ rpc: async(n,a)=>{window.__rpc.push([n,a]); return {data:{ok:true},error:null}},
        from:()=>({upsert: async(row)=>{window.__upserts.push(row); return {error:null}}}) }; }"""
    with page(url, splash=False, geolocation={'latitude': 0.3476, 'longitude': 32.5825, 'accuracy': 12}, permissions=['geolocation']) as pg:
        pg.evaluate(SETUP)
        pg.evaluate("()=>{SYSTEM_SETTINGS.locationColumnsPresent=true; SYSTEM_SETTINGS.locationCheckMode='off'}")
        pg.evaluate("async()=>{await shareLecturerLocation('b1'); await reportCheckInLocation('b1')}")
        check('off: no position is requested or sent', pg.evaluate("()=>window.__rpc.length") == 0)
        pg.evaluate("()=>{SYSTEM_SETTINGS.locationColumnsPresent=false; SYSTEM_SETTINGS.locationCheckMode='flag'}")
        pg.evaluate("async()=>{await reportCheckInLocation('b1')}")
        check('migration not run: nothing is sent', pg.evaluate("()=>window.__rpc.length") == 0)
        pg.evaluate("()=>{SYSTEM_SETTINGS.locationColumnsPresent=true}")
        pg.evaluate("async()=>{await shareLecturerLocation('b1')}")
        r = pg.evaluate("()=>window.__rpc.slice()")
        check('lecturer start sends position to set_session_location', len(r) == 1 and r[0][0] == 'set_session_location' and abs(r[0][1]['p_lat'] - 0.3476) < 1e-6 and r[0][1]['p_broadcast_id'] == 'b1', str(r))
        pg.evaluate("()=>{window.__rpc.length=0}")
        pg.evaluate("async()=>{await reportCheckInLocation('b1')}")
        r = pg.evaluate("()=>window.__rpc.slice()")
        check('student check-in sends position to record_checkin_location', len(r) == 1 and r[0][0] == 'record_checkin_location' and abs(r[0][1]['p_lng'] - 32.5825) < 1e-6, str(r))
        src = pg.evaluate("()=>completeCheckIn.toString()")
        check('only a live, server-recorded check-in is located (never a queued one)',
              "server.state === 'ok' && !outcome.offline" in src and 'reportCheckInLocation' in src)
        pg.evaluate("()=>{State.role='administrator';State.user={name:'G',staffId:'VU-ADM-001',id:'VU-ADM-001'};renderApp();navigate('attendancePolicies')}")
        pg.wait_for_timeout(400)
        check('policy screen shows the location setting once the migration exists', pg.evaluate("()=>!!document.getElementById('policyLocationMode')"))
        pg.evaluate("()=>{document.getElementById('policyLocationMode').value='flag';document.getElementById('policyLocationRadius').value='200';saveAttendancePolicies()}")
        pg.wait_for_timeout(300)
        up = pg.evaluate("()=>window.__upserts.slice(-1)[0]")
        check('saving sends the mode and radius', up and up.get('location_check_mode') == 'flag' and up.get('location_check_radius_m') == 200, str(up))
        pg.evaluate("()=>{document.getElementById('policyLocationRadius').value='5';window.__before=window.__upserts.length;saveAttendancePolicies()}")
        check('a radius outside 50-2000 m is refused', pg.evaluate("()=>window.__upserts.length===window.__before"))
        pg.evaluate("()=>{SYSTEM_SETTINGS.locationColumnsPresent=false; window.__upserts.length=0; saveSystemSettingsToSupabase()}")
        pg.wait_for_timeout(200)
        up = pg.evaluate("()=>window.__upserts[0]")
        check('before the migration, saving settings leaves the new columns out', up and 'location_check_mode' not in up, str(up))
        check('no page errors', not pg.errors, '; '.join(pg.errors)[:200])
    with page(url, splash=False, permissions=[]) as pg:
        pg.evaluate(SETUP)
        pg.evaluate("()=>{SYSTEM_SETTINGS.locationColumnsPresent=true; SYSTEM_SETTINGS.locationCheckMode='flag'; navigator.geolocation.getCurrentPosition=(ok,err)=>err({code:1})}")
        pg.evaluate("async()=>{await reportCheckInLocation('b1')}")
        r = pg.evaluate("()=>window.__rpc.slice()")
        check('permission denied: the server is told "no location", the check-in stands',
              len(r) == 1 and r[0][1]['p_lat'] is None, str(r))
        txt = pg.evaluate("()=>{State.user={name:'Aisha Nakamya'};renderConsentScreen();return document.getElementById('screens').innerText}")
        check('consent notice explains the location request when it is on', 'share its location once' in txt)
        pg.evaluate("()=>{SYSTEM_SETTINGS.locationCheckMode='off';renderConsentScreen()}")
        txt = pg.evaluate("()=>document.getElementById('screens').innerText")
        check('consent notice keeps the old wording when it is off', 'not your camera, microphone, or location' in txt)

def lecturer_courses(url):
    print('lecturer course assignments reach the database')
    with page(url, splash=False) as pg:
        r = pg.evaluate("""async()=>{
          const db={classes:[{code:'C1',teacher_id:'L'},{code:'C2',teacher_id:null},{code:'C3',teacher_id:'X'},{code:'C4',teacher_id:'L'}],
                    users:[{id:'L',university_id:'VU-LEC-101'}]};
          let blocked=false;
          const mk=(table)=>{ let op='select',patch=null,f=[],cols=null;
            const rows=()=>db[table].filter(r=>f.every(x=>x(r)));
            const q={select(c){cols=c;return q},update(p){op='update';patch=p;return q},in(c,v){f.push(r=>v.includes(r[c]));return q},eq(c,v){f.push(r=>r[c]===v);return q},
              maybeSingle(){return Promise.resolve({data:rows()[0]||null,error:null})},
              then(res,rej){ let out;
                if(op==='update'){ if(blocked) out={data:[],error:null}; else { const hit=rows(); hit.forEach(r=>Object.assign(r,patch)); out={data:hit.map(r=>({code:r.code})),error:null}; } }
                else out={data:rows().map(r=>({code:r.code})),error:null};
                return Promise.resolve(out).then(res,rej); }};
            return q};
          SUPABASE_CLIENT={from:mk}; LIVE_BACKEND=true;
          const out={};
          out.res1=await liveSetLecturerCourses('VU-LEC-101',['C2','C4']);
          out.after1=db.classes.map(c=>c.code+':'+c.teacher_id).join(',');
          blocked=true;
          out.res2=await liveSetLecturerCourses('VU-LEC-101',['C4']);
          out.res3=await liveSetLecturerCourses('NOPE',['C4']);
          blocked=false;
          out.res4=await liveSetLecturerCourses('VU-LEC-101',['C2','C4','GHOST']);
          out.src=submitEditStaff.toString();
          LIVE_BACKEND=false; out.offline=await liveSetLecturerCourses('VU-LEC-101',['C1']);
          return out}""")
        check('assigning and unassigning writes teacher_id', r['res1'] == {'ok': True} and r['after1'] == 'C1:null,C2:L,C3:X,C4:L', f"{r['res1']} {r['after1']}")
        check('a write blocked by access rules is reported, not trusted', 'error' in (r['res2'] or {}), str(r['res2']))
        check('a lecturer with no live account is reported', 'error' in (r['res3'] or {}), str(r['res3']))
        check('a demo-only course is skipped without failing the save', r['res4'] == {'ok': True}, str(r['res4']))
        check('offline/demo mode keeps the local-only behaviour', r['offline'] is None)
        check('the Edit Lecturer save calls it before changing local state', r['src'].index('liveSetLecturerCourses') < r['src'].index('COURSES.forEach'))
        check('no page errors', not pg.errors, '; '.join(pg.errors)[:200])

def shared_settings(url):
    print('admin settings are shared across devices')
    with page(url, splash=False) as pg:
        r = pg.evaluate("""async()=>{
          const out={}; window.__up=[]; LIVE_BACKEND=true;
          const row={id:1,system_name:'QRAST',attendance_policies:{minAttendancePct:80,lateGraceMinutes:15,qrRotateSeconds:9999,sessionWindowMinutes:'x'},
            fraud_thresholds:{sharedDeviceWindowMinutes:7,maxCheckInsPerDevice:2,flagOnVPN:true,evil:1},
            notification_templates:{sessionStarted:{subject:'Open: {courseName}',body:'Hello {studentName}',enabled:false},nonsense:{subject:'x'}}};
          SUPABASE_CLIENT={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:row,error:null})})}),upsert:async(r)=>{window.__up.push(r);return {error:null}}})};
          await loadSystemSettingsFromSupabase();
          out.minPct=ATTENDANCE_POLICIES.minAttendancePct; out.grace=ATTENDANCE_POLICIES.lateGraceMinutes;
          out.qrKept=ATTENDANCE_POLICIES.qrRotateSeconds; out.winKept=ATTENDANCE_POLICIES.sessionWindowMinutes;
          out.ft=[FRAUD_THRESHOLDS.sharedDeviceWindowMinutes,FRAUD_THRESHOLDS.maxCheckInsPerDevice,FRAUD_THRESHOLDS.flagOnVPN];
          out.tpl=[NOTIFICATION_TEMPLATES.sessionStarted.subject,NOTIFICATION_TEMPLATES.sessionStarted.enabled];
          out.noJunk=!('nonsense' in NOTIFICATION_TEMPLATES) && !('evil' in FRAUD_THRESHOLDS);
          // saving
          State.role='administrator';State.user={name:'G',staffId:'VU-ADM-001',id:'VU-ADM-001'};
          toggleNotifTemplate('sessionStarted',true); await new Promise(r=>setTimeout(r,100));
          const last=window.__up.slice(-1)[0]; out.saved=last&&last.notification_templates&&last.notification_templates.sessionStarted.enabled===true&&last.attendance_policies.minAttendancePct===80;
          // before the migration: nothing extra is sent and the admin is told
          SYSTEM_SETTINGS.sharedColumnsPresent=false; window.__up.length=0; await saveSystemSettingsToSupabase();
          out.noExtra=!('attendance_policies' in window.__up[0]);
          return out}""")
        check('minimum attendance is picked up from the database', r['minPct'] == 80)
        check('late grace is picked up from the database', r['grace'] == 15)
        check('an out-of-range or wrong-type value is ignored', r['qrKept'] == 30 and r['winKept'] == 10, f"{r['qrKept']} {r['winKept']}")
        check('fraud thresholds are picked up; unknown keys ignored', r['ft'] == [7, 2, True] and r['noJunk'], str(r))
        check('a template edit is picked up', r['tpl'] == ['Open: {courseName}', False], str(r['tpl']))
        check('changing a template saves all shared settings to the database', r['saved'])
        check('before the migration, saving settings leaves the new columns out', r['noExtra'])
        check('no page errors', not pg.errors, '; '.join(pg.errors)[:200])

def stale_sessions(url):
    print('sessions left running are not resumed')
    with page(url, splash=False) as pg:
        r = pg.evaluate("""async()=>{
          const out={}, H=3600000;
          const cut=new Date(liveSessionCutoffISO()).getTime(), mid=new Date().setHours(0,0,0,0);
          out.cutoff = cut>=mid && cut>=Date.now()-4*H-1000 && cut<=Date.now();
          out.oldIsStale = isStaleBroadcastRow({started_at:new Date(Date.now()-5*H).toISOString()}) && isStaleBroadcastRow({started_at:new Date(mid-60000).toISOString()}) && isStaleBroadcastRow({});
          out.freshIsLive = !isStaleBroadcastRow({started_at:new Date(Math.max(mid, Date.now()-60000)).toISOString()});
          // record every query's filters
          const log=[]; let rows=[];
          const qb=(t)=>{const f=[];const q={select(){return q},update(v){f.push(['update',v]);return q},in(c,v){f.push(['in',c]);return q},eq(c,v){f.push(['eq',c,v]);return q},gte(c,v){f.push(['gte',c,v]);return q},lt(c,v){f.push(['lt',c,v]);return q},order(){return q},limit(){return q},
            maybeSingle:async()=>{log.push([t,f]);return {data:rows[0]||null,error:null}},then(res,rej){log.push([t,f]);return Promise.resolve({data:rows,error:null}).then(res,rej)}};return q};
          SUPABASE_CLIENT={from:(t)=>qb(t),rpc:async()=>({data:null,error:null}),channel:()=>({on(){return this},subscribe(){return this}}),removeChannel(){},auth:{getSession:async()=>({data:{session:null}})}};
          LIVE_BACKEND=true; State.role='lecturer'; State.user={name:'Dr. Patrick Mukasa',staffId:'VU-LEC-101',id:'VU-LEC-101',supabaseId:'lec-1'};
          await liveFindActiveSession('CSC3101','day',null,'lec-1');
          const f1=log[log.length-1][1];
          out.findFilters = f1.some(x=>x[0]==='eq'&&x[1]==='lecturer_id'&&x[2]==='lec-1') && f1.some(x=>x[0]==='gte'&&x[1]==='started_at');
          log.length=0; await liveEndOwnStaleSessions();
          const f2=log[0]&&log[0][1]||[];
          out.endsOwnStale = f2.some(x=>x[0]==='update'&&x[1].active===false) && f2.some(x=>x[0]==='eq'&&x[1]==='lecturer_id'&&x[2]==='lec-1') && f2.some(x=>x[0]==='lt'&&x[1]==='started_at');
          log.length=0; LIVE_SESSION.mode=null; await checkLecturerActiveSession();
          out.dashboardEndsStaleFirst = log.length>1 && log[0][1].some(x=>x[0]==='update') && log.slice(1).every(([t,f])=>f.some(x=>x[0]==='eq'&&x[1]==='lecturer_id'));
          // a student's phone ignores a stale broadcast pushed over Realtime
          State.role='student'; State.user={name:'A',reg:'VU-X',id:'VU-X',mode:'day',supabaseId:'u1'};
          LIVE_SESSION.liveSessionId=null; LIVE_SESSION.active=false;
          const base={course_code:STUDENT_COURSES[0].code,course_name:'DS',room:'LT1',mode:'day',active:true,window_seconds:600,token_rotate_seconds:30,pin:null,token:null,coordinator_authorized:false,class_id:null};
          handleStudentLiveRow({new:{...base,id:'old',started_at:new Date(Date.now()-26*H).toISOString()}});
          out.studentIgnoresStale = LIVE_SESSION.liveSessionId!=='old';
          handleStudentLiveRow({new:{...base,id:'new',started_at:new Date().toISOString()}});
          out.studentTakesFresh = LIVE_SESSION.liveSessionId==='new';
          return out}""")
        for k, label in [('cutoff', 'cutoff is today and at most 4 hours back'), ('oldIsStale', 'a broadcast from yesterday or 5 hours ago is stale'),
                         ('freshIsLive', 'a broadcast started a minute ago is not stale'), ('findFilters', "the lecturer only resumes their own, recent broadcast"),
                         ('endsOwnStale', "the lecturer's own stale broadcasts are ended"), ('dashboardEndsStaleFirst', 'the dashboard ends stale broadcasts before looking'),
                         ('studentIgnoresStale', 'a student ignores a stale broadcast'), ('studentTakesFresh', 'a student still picks up a fresh one')]:
            check(label, r[k])
        check('no page errors', not pg.errors, '; '.join(pg.errors)[:200])


def cohort_enrollment(url):
    print('saving a course enrolls its existing cohort')
    with page(url, splash=False) as pg:
        r = pg.evaluate("""async()=>{
          const out={}, log=[]; let inserted=null;
          const students=[{id:'s1'},{id:'s2'},{id:'s3'}];
          const qb=(t)=>{const f=[];const q={select(){return q},eq(c,v){f.push([c,v]);return q},
            insert(rows){inserted=rows;log.push([t,'insert']);return Promise.resolve({error:null})},
            then(res,rej){log.push([t,f]);const data=t==='users'?students:t==='enrollments'?[{student_id:'s2'}]:[];return Promise.resolve({data,error:null}).then(res,rej)}};return q};
          SUPABASE_CLIENT={from:(t)=>qb(t)}; LIVE_BACKEND=true;
          const res=await liveEnrollCohortInClass('c1','Computer Science','Year 2','day','computing');
          const uf=log.find(x=>x[0]==='users')[1];
          out.filters=['role','program','year','mode','faculty_key'].every(k=>uf.some(x=>x[0]===k)) && uf.find(x=>x[0]==='program')[1]==='Computer Science' && uf.find(x=>x[0]==='mode')[1]==='day';
          out.onlyMissing=res.count===2 && inserted.length===2 && inserted.every(r=>r.class_id==='c1') && !inserted.some(r=>r.student_id==='s2');
          log.length=0; await liveEnrollCohortInClass('c1','Computer Science','Year 2',null);
          out.noModeMeansAll=!log.find(x=>x[0]==='users')[1].some(x=>x[0]==='mode');
          log.length=0; const skip=await liveEnrollCohortInClass('c1','Computer Science',null,'day');
          out.skipsWithoutYear=skip.count===0 && log.length===0;
          out.notes=cohortEnrollNote({count:2}).includes('2 students enrolled') && cohortEnrollNote({count:0})==='' && cohortEnrollNote({error:'x'}).includes('could not');
          return out}""")
        for k, label in [('filters', 'looks up students by programme, year and mode'), ('onlyMissing', 'enrolls only the students not already in the class'),
                         ('noModeMeansAll', 'a class with no mode takes Day and Evening students'), ('skipsWithoutYear', 'nothing happens until the course has a year'),
                         ('notes', 'the save message says how many were enrolled')]:
            check(label, r[k])
        check('no page errors', not pg.errors, '; '.join(pg.errors)[:200])


def no_phantom_broadcast(url):
    print('only Start Session creates a broadcast')
    with page(url, splash=False) as pg:
        r = pg.evaluate("""async()=>{
          const out={}, calls=[];
          const q={insert(p){calls.push('insert');return q},update(p){calls.push('update');return q},eq(){return Promise.resolve({error:null})},select(){return q},single:async()=>({data:{id:'new-1',started_at:new Date().toISOString()},error:null})};
          SUPABASE_CLIENT={from:()=>q,rpc:async()=>({data:null,error:null})}; LIVE_BACKEND=true;
          State.role='lecturer'; State.user={name:'P',staffId:'VU-LEC-101',id:'VU-LEC-101',supabaseId:'lec-1'};
          // a fresh load: active defaults to true, no broadcast id
          LIVE_SESSION.liveSessionId=null; LIVE_SESSION.active=true;
          out.rotationSkipped = (await liveWriteSession())==='skipped' && calls.length===0;
          await rotateSessionToken(); out.tickerCreatesNothing = calls.length===0;
          await new Promise(r=>setTimeout(r,50));
          out.created = (await liveWriteSession({create:true}))==='ok' && calls.includes('insert') && LIVE_SESSION.liveSessionId==='new-1';
          calls.length=0; await liveWriteSession(); out.laterWritesUpdate = calls.length===1 && calls[0]==='update';
          return out}""")
        for k, label in [('rotationSkipped', 'a write with no broadcast does nothing'), ('tickerCreatesNothing', 'the QR rotation cannot create a broadcast'),
                         ('created', 'Start Session still creates one'), ('laterWritesUpdate', 'later writes update that broadcast')]:
            check(label, r[k])
        check('no page errors', not pg.errors, '; '.join(pg.errors)[:200])


if __name__ == '__main__':
    import sys
    quick = '--quick' in sys.argv
    with site() as url:
        layout(url); backup_pin(url); calendar(url); quick_messages(url); a11y(url); location_check(url); lecturer_courses(url); shared_settings(url); stale_sessions(url); cohort_enrollment(url); no_phantom_broadcast(url)
        if not quick:
            recheck(url); realtime(url)
    finish()
