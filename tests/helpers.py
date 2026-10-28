"""Shared pieces for the browser tests. Run everything with:  python3 tests/run_all.py"""
import contextlib, socket, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FAILS = []

def check(name, ok, detail=''):
    print(('  ok   ' if ok else '  FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''))
    if not ok:
        FAILS.append(name)

@contextlib.contextmanager
def site():
    """Serve the repo on a free port; yield the base URL."""
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port)], cwd=ROOT,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        yield f'http://127.0.0.1:{port}/index.html'
    finally:
        srv.kill()

@contextlib.contextmanager
def page(url, viewport=(1366, 768), splash=True, **ctx):
    """A page with the network to Supabase blocked, the consent and password
    gates stubbed, and the splash screen waited out. Collects page errors."""
    with sync_playwright() as p:
        b = p.chromium.launch()
        c = b.new_context(service_workers='block', viewport={'width': viewport[0], 'height': viewport[1]}, **ctx)
        pg = c.new_page(); pg.errors = []
        pg.on('pageerror', lambda e: pg.errors.append(str(e)))
        pg.route('**/*.supabase.co/**', lambda r: r.abort())
        # The app's reachability check (checkBackendStatus) asks Supabase for
        # /auth/v1/health. It is blocked here, so when its failure arrives the app
        # sets LIVE_BACKEND = false. It runs at start-up and again on every redraw
        # of the login screen, which a test causes whenever it re-renders before
        # setting a role, and its failure could land after the test had set
        # LIVE_BACKEND = true itself, so the test's writes skipped its mock
        # database at random. Wait out the start-up check, then switch it off.
        health = []
        pg.on('requestfailed', lambda req: health.append(1) if '/auth/v1/health' in req.url else None)
        pg.goto(url); pg.wait_for_timeout(1000)
        for _ in range(60):
            if health: break
            pg.wait_for_timeout(100)
        pg.wait_for_timeout(50)
        pg.evaluate("()=>{window.consentGate=()=>false;window.mustChangePasswordGate=()=>false;window.checkBackendStatus=async()=>{}}")
        if splash: pg.wait_for_timeout(4600)
        try:
            yield pg
        finally:
            b.close()

USERS = {
    'administrator': {'name': 'Grace Namirembe', 'staffId': 'VU-ADM-001', 'id': 'VU-ADM-001'},
    'registrar': {'name': 'Denis Okwir', 'staffId': 'VU-REG-COMP-001', 'id': 'VU-REG-COMP-001', 'facultyKey': None},
    'lecturer': {'name': 'Dr. Patrick Mukasa', 'staffId': 'VU-LEC-101', 'id': 'VU-LEC-101'},
    'student': {'name': 'Aisha Nakamya', 'reg': 'VU-CSF-2401-0001-DAY', 'id': 'VU-CSF-2401-0001-DAY', 'mode': 'day'},
}

def finish():
    print()
    if FAILS:
        print(f'{len(FAILS)} check(s) failed: ' + '; '.join(FAILS)); sys.exit(1)
    print('all checks passed')
