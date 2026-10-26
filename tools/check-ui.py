# Requires Python Playwright and its Chromium browser. Uses an isolated browser context.
# Optional argument: Castline development base URL (HTTPS or localhost).
import sys
BASE = (sys.argv[1] if len(sys.argv) > 1 else 'https://192.168.11.100:8011/ff14tools/castline/').rstrip('/') + '/'
from playwright.sync_api import sync_playwright
from pathlib import Path
import json
import os
out=Path(os.environ.get('CASTLINE_SHOTS') or Path(__file__).resolve().parent.parent/'.shots');out.mkdir(parents=True,exist_ok=True)
base=BASE
with sync_playwright() as p:
 b=p.chromium.launch(args=['--no-sandbox'])
 context=b.new_context(ignore_https_errors=True,viewport={'width':1440,'height':1080})
 page=context.new_page(); errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(base);page.wait_for_timeout(300)
 print('TITLE',page.title())
 for v in ['home','setup','player','manage','recorder','generator','lab']:
  page.evaluate('(v)=>location.hash=v',v);page.wait_for_timeout(1200)
  print(v, 'message:',page.locator('#app-message').inner_text(), 'h1:',page.locator(f'#view-{v} h1').count())
  page.screenshot(path=str(out/f'{v}-desktop.png'),full_page=True)
 page.evaluate('location.hash="home"');page.wait_for_timeout(200)
 assert 'btn-primary' in page.locator('#home-review').get_attribute('class')
 print('new user:',page.locator('#setup-summary-title').inner_text())
 sample={k:{'x':10,'y':10+i*30,'w':200,'h':20} for i,k in enumerate(['content','countdown','hp','cast','enmity'])}
 page.evaluate('(regions)=>{localStorage.setItem("castline.regions",JSON.stringify({"1920x1080":regions}));dispatchEvent(new StorageEvent("storage",{key:"castline.regions"}));}',sample)
 page.wait_for_timeout(200);assert 'btn-primary' in page.locator('#home-next').get_attribute('class')
 page.screenshot(path=str(out/'home-configured.png'),full_page=True)
 page.locator('#home-review').click();page.wait_for_timeout(300)
 assert page.locator('#setup-setup-done').is_visible()
 assert not page.locator('#setup-setup-steps').is_visible()
 page.screenshot(path=str(out/'setup-configured.png'),full_page=True)
 page.set_viewport_size({'width':390,'height':844})
 for v in ['home','setup','player','manage','recorder','generator','lab']:
  page.evaluate('(v)=>location.hash=v',v);page.wait_for_timeout(300)
  assert not page.evaluate('document.documentElement.scrollWidth > innerWidth'), v
  print('mobile',v,'overflow',False)
  page.screenshot(path=str(out/f'{v}-mobile.png'),full_page=True)
 ids=page.locator('[id]').evaluate_all('(els)=>els.map(e=>e.id)')
 assert len(ids)==len(set(ids)), 'Duplicate IDs'
 assert not errors, errors
 print('DUPLICATE IDS',[]);print('ERRORS',errors)
 (out/'results.json').write_text(json.dumps({'errors':errors},ensure_ascii=False,indent=2))
 b.close()
