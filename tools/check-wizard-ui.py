import sys
BASE = (sys.argv[1] if len(sys.argv)>1 else "https://192.168.11.100:8011/ff14tools/castline/").rstrip("/")+"/"
from playwright.sync_api import sync_playwright
from pathlib import Path
out=Path('/tmp/castline-wizard-2026-10-25');out.mkdir(exist_ok=True)
with sync_playwright() as p:
 b=p.chromium.launch(args=['--no-sandbox'])
 c=b.new_context(ignore_https_errors=True,viewport={'width':1440,'height':1000})
 c.add_init_script('''navigator.mediaDevices.getDisplayMedia=async()=>{window.calls=(window.calls||0)+1;let c=document.createElement('canvas');c.width=1920;c.height=1080;let ctx=c.getContext('2d');function draw(){ctx.fillStyle='#234';ctx.fillRect(0,0,1920,1080);ctx.fillText(Date.now(),10,20);requestAnimationFrame(draw)}draw();let s=c.captureStream(10);window.track=s.getVideoTracks()[0];return s;}''')
 page=c.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(BASE)
 assert page.locator('[data-wizard-marker]').count()==3
 assert page.locator('#wizard-count').inner_text()=='1 / 3'
 page.locator('#capture-start').click();page.wait_for_function('document.getElementById("capture-stop").hidden===false')
 page.locator('#wizard-next').click();page.wait_for_url('**/#setup');page.wait_for_timeout(200)
 assert page.locator('#wizard-count').inner_text()=='2 / 3'
 regions={k:{'x':10,'y':10+i*40,'w':300,'h':30} for i,k in enumerate(['content','countdown','hp','cast','enmity'])}
 page.evaluate('(r)=>{localStorage.setItem("castline.regions",JSON.stringify({"1920x1080":r}));dispatchEvent(new StorageEvent("storage",{key:"castline.regions"}));}',regions)
 page.locator('#wizard-next').click();page.wait_for_url('**/#player')
 page.wait_for_function('!document.getElementById("player-stop").disabled',timeout=60000)
 assert page.locator('#player-timeline-select').is_visible()
 assert page.locator('#player-tts').is_visible()
 assert page.locator('#player-panel').is_visible()
 assert page.locator('#wizard-next').is_hidden()
 assert page.evaluate('window.calls')==1
 page.locator('#player-stop').click();page.wait_for_timeout(300)
 assert page.locator('#player-stop').is_disabled()
 assert page.evaluate('window.track.readyState')=='live'
 page.evaluate('location.hash="home"');page.wait_for_timeout(200)
 page.locator('#wizard-next').click();page.wait_for_url('**/#player')
 page.wait_for_function('!document.getElementById("player-stop").disabled',timeout=60000)
 page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(200)
 assert not page.evaluate('document.documentElement.scrollWidth>innerWidth')
 assert not errors,errors
 print('Combined playback: three stages, settings and timeline together, auto reading, manual stop, configured skip and mobile passed. Errors:',errors)
 b.close()
