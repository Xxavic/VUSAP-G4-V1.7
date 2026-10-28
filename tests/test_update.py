"""A new deploy (changed sw.js) must produce the 'new version ready' banner in an
already-open page, and a first install must not."""
import shutil, tempfile
from pathlib import Path
from helpers import *
from playwright.sync_api import sync_playwright
import subprocess, socket, sys, time

def run():
    print('update prompt')
    tmp = Path(tempfile.mkdtemp())
    shutil.copytree(ROOT, tmp / 'site', ignore=shutil.ignore_patterns('.git', 'dist', 'design', 'node_modules', '__pycache__'))
    site_dir = tmp / 'site'
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(port)], cwd=site_dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            pg = b.new_context(service_workers='allow').new_page(); pg.errors = []
            pg.on('pageerror', lambda e: pg.errors.append(str(e)))
            pg.route('**/*.supabase.co/**', lambda r: r.abort())
            pg.goto(f'http://127.0.0.1:{port}/index.html'); pg.wait_for_timeout(4000)
            pg.evaluate("async()=>{await navigator.serviceWorker.ready}")
            pg.wait_for_timeout(1000)
            check('no banner after the very first install', pg.query_selector('#updateBanner') is None)
            sw = site_dir / 'sw.js'
            sw.write_text(sw.read_text().replace("CACHE_NAME = '", "CACHE_NAME = 'new-"))
            pg.evaluate("async()=>{const r=await navigator.serviceWorker.getRegistration(); await r.update()}")
            pg.wait_for_timeout(3000)
            check('banner appears when a new version is deployed', pg.query_selector('#updateBanner') is not None)
            check('banner has a Reload button', pg.query_selector('#updateReloadBtn') is not None)
            pg.click('#updateLaterBtn')
            check('Later dismisses it', pg.query_selector('#updateBanner') is None)
            check('no page errors', not pg.errors, '; '.join(pg.errors)[:200])
            b.close()
    finally:
        srv.kill(); shutil.rmtree(tmp, ignore_errors=True)

if __name__ == '__main__':
    run(); finish()
