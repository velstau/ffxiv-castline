import sys, os
BASE = (sys.argv[1] if len(sys.argv)>1 else "https://192.168.11.100:8011/ff14tools/castline/").rstrip("/")+"/"
from playwright.sync_api import sync_playwright
from pathlib import Path
# 画面の保存先は CASTLINE_SHOTS（未指定なら保存しない）
out=Path(os.environ['CASTLINE_SHOTS']) if os.environ.get('CASTLINE_SHOTS') else None
if out: out.mkdir(parents=True,exist_ok=True)
def shot(page,name):
 if out: page.screenshot(path=str(out/name),full_page=True)
with sync_playwright() as p:
 b=p.chromium.launch(args=['--no-sandbox'])
 c=b.new_context(ignore_https_errors=True,viewport={'width':1440,'height':1000})
 c.add_init_script('''navigator.mediaDevices.getDisplayMedia=async()=>{window.calls=(window.calls||0)+1;let c=document.createElement('canvas');c.width=1920;c.height=1080;let ctx=c.getContext('2d');function draw(){ctx.fillStyle='#234';ctx.fillRect(0,0,1920,1080);ctx.fillText(Date.now(),10,20);requestAnimationFrame(draw)}draw();let s=c.captureStream(10);window.track=s.getVideoTracks()[0];return s;}''')
 page=c.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(BASE);page.wait_for_timeout(500)
 # 初めての人: 初期設定のボタンだけが塗られ、状態の一覧は「まだ」
 assert 'btn-primary' in page.locator('#home-review').get_attribute('class')
 assert 'btn-primary' not in page.locator('#home-next').get_attribute('class')
 assert page.locator('#home-st-regions .status-line.todo').count()==1
 shot(page,'home-new.png')
 page.locator('#home-review').click();page.wait_for_url('**/#setup')
 page.locator('#capture-start').click();page.wait_for_function('document.getElementById("capture-stop").hidden===false')
 regions={k:{'x':10,'y':10+i*40,'w':300,'h':30} for i,k in enumerate(['content','countdown','hp','cast','enmity'])}
 page.evaluate('(r)=>{localStorage.setItem("castline.regions",JSON.stringify({"1920x1080":r}));dispatchEvent(new StorageEvent("storage",{key:"castline.regions"}));}',regions)
 page.evaluate('location.hash="home"');page.wait_for_timeout(300)
 # 設定が済むと、再生のボタンに切り替わる
 assert 'btn-primary' in page.locator('#home-next').get_attribute('class')
 assert page.locator('#home-st-capture .status-line.ok').count()==1
 assert page.locator('#home-st-regions .status-line.ok').count()==1
 shot(page,'home-ready.png')
 page.locator('#home-next').click();page.wait_for_url('**/#player')
 # 共有済みなので自動で読み取りを始め、チェックリストの 4 が済みになる
 page.wait_for_function('!document.getElementById("player-stop").hidden',timeout=60000)
 page.wait_for_function('document.getElementById("player-guide-capture").classList.contains("done")',timeout=5000)
 assert 'done' in page.locator('#player-guide-setup').get_attribute('class')
 assert page.locator('#player-share').is_hidden()
 assert page.locator('#player-timeline-select').is_visible()
 assert page.locator('#player-tts').is_visible()
 assert page.evaluate('window.calls')==1
 shot(page,'player-running.png')
 page.locator('#player-stop').click();page.wait_for_timeout(300)
 assert page.locator('#player-stop').is_hidden() and page.locator('#player-start').is_visible()
 assert page.evaluate('window.track.readyState')=='live'
 page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(200)
 assert not page.evaluate('document.documentElement.scrollWidth>innerWidth')
 assert not errors,errors
 print('Flow: home highlights setup first, then playback; checklist marks capture done; manual stop keeps the share; mobile passed.')
 b.close()
