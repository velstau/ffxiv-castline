# Requires Python Playwright and its Chromium browser. Uses an isolated browser context.
# Optional argument: Castline development base URL (HTTPS or localhost).
import sys
BASE = (sys.argv[1] if len(sys.argv) > 1 else 'https://192.168.11.100:8011/ff14tools/castline/').rstrip('/') + '/'
from playwright.sync_api import sync_playwright
from pathlib import Path
base=BASE
with sync_playwright() as p:
 b=p.chromium.launch(args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
 c=b.new_context(ignore_https_errors=True,viewport={'width':1440,'height':1000})
 c.add_init_script('''window.shareCalls=0;window.testTrack=null;
 navigator.mediaDevices.getDisplayMedia=async()=>{window.shareCalls++;const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;const ctx=canvas.getContext('2d');function draw(){ctx.fillStyle='#25354a';ctx.fillRect(0,0,1920,1080);ctx.fillStyle='#ffffff';ctx.font='32px sans-serif';ctx.fillText('Castline capture test '+Date.now(),50,70);window.testTimer=requestAnimationFrame(draw);}draw();const stream=canvas.captureStream(10);window.testTrack=stream.getVideoTracks()[0];return stream;};''')
 page=c.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(base)
 regions={k:{'x':10,'y':10+i*40,'w':300,'h':30} for i,k in enumerate(['content','countdown','hp','cast','enmity'])}
 page.evaluate('(r)=>{localStorage.setItem("castline.regions",JSON.stringify({"1920x1080":r}));dispatchEvent(new StorageEvent("storage",{key:"castline.regions"}));}',regions)
 page.locator('#capture-start').click();page.wait_for_function('document.getElementById("capture-stop").hidden===false')
 for v in ['setup','player']:
  page.evaluate('(v)=>location.hash=v',v);page.wait_for_timeout(350)
  print('checking',v,flush=True)
  if v=='player':
   page.wait_for_function('!document.getElementById("player-stop").disabled',timeout=60000)
  else:page.wait_for_function('!document.getElementById("setup-checks-grab").disabled',timeout=60000)
  page.wait_for_timeout(500)
  assert page.evaluate('window.shareCalls')==1
  assert page.evaluate('window.testTrack.readyState')=='live'
 page.locator('#player-stop').click();assert page.evaluate('window.testTrack.readyState')=='live'
 page.evaluate('location.hash="recorder"');page.wait_for_timeout(500)
 page.locator('input[name="recorder-input"][value="screen"]').check()
 page.locator('#recorder-screen-start').click();page.wait_for_timeout(1200)
 assert page.evaluate('window.shareCalls')==1
 assert page.evaluate('window.testTrack.readyState')=='live'
 page.evaluate('location.hash="manage"');page.wait_for_timeout(200)
 assert page.evaluate('window.testTrack.readyState')=='live'
 page.locator('#capture-stop').click();assert page.evaluate('window.testTrack.readyState')=='ended'
 page.locator('#capture-start').click();page.wait_for_timeout(500)
 assert page.evaluate('window.shareCalls')==2
 page.evaluate('window.testTrack.dispatchEvent(new Event("ended"))');page.wait_for_timeout(200)
 assert page.locator('#capture-start').is_visible()
 print('Capture assertions passed: single selector across setup/player/recorder, per-view stop retains stream, global/browser stop ends stream, restart works.')
 assert not errors, errors
 print('ERRORS',errors)
 b.close()
