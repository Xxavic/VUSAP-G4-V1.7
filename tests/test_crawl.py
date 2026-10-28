"""Renders every routed screen for every role and checks for: render errors,
dead links (navigate('x') to a screen the role does not have), nav items that
go nowhere, and uncaught page errors."""
from helpers import *

JS = r"""()=>{
 const src=getScreenHTML.toString(); const out={};
 const roles=%s;
 for(const role of Object.keys(roles)){
   State.role=role; State.user=roles[role];
   const block=src.split(/State\.role === '/).find(b=>b.startsWith(role));
   const screens=[...block.matchAll(/case '(\w+)'/g)].map(m=>m[1]);
   out[role]={screens:{},nav:(NAV_CONFIG[role]||[]).map(i=>i.id),all:screens};
   for(const s of screens){
     let html=''; try{ html=getScreenHTML(s)||''; }catch(e){ html='ERR '+e.message; }
     out[role].screens[s]={err:html.startsWith('ERR')?html:null,
       links:[...new Set([...html.matchAll(/navigate\('(\w+)'/g)].map(m=>m[1]))]};
   }
 }
 return out}"""

import json
def run():
    print('crawl: every screen, every role')
    with site() as url, page(url, splash=False) as pg:
        data = pg.evaluate(JS % json.dumps(USERS))
        total = 0
        for role, d in data.items():
            known = set(d['all']) | {'back'}
            for s, info in d['screens'].items():
                total += 1
                check(f'{role}/{s} renders', not info['err'], info['err'])
                dead = [l for l in info['links'] if l not in known]
                check(f'{role}/{s} has no dead links', not dead, ', '.join(dead))
            check(f'{role} nav items all exist', all(n in known for n in d['nav']), str(d['nav']))
        print(f'  ({total} screens)')
        check('no uncaught page errors', not pg.errors, '; '.join(pg.errors)[:300])

if __name__ == '__main__':
    run(); finish()
