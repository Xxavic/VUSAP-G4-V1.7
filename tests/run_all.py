"""python3 tests/run_all.py [--quick]   (needs: pip install playwright && playwright install chromium)"""
import subprocess, sys
from pathlib import Path
here = Path(__file__).parent
rc = 0
for script in ('test_crawl.py', 'test_features.py'):
    rc |= subprocess.call([sys.executable, str(here / script)] + sys.argv[1:], cwd=here)
sys.exit(1 if rc else 0)
