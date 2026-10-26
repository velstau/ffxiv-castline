import sys
BASE=(sys.argv[1] if len(sys.argv)>1 else "https://192.168.11.100:8011/ff14tools/castline/").rstrip("/")+"/"
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(args=['--no-sandbox']);page=b.new_page(ignore_https_errors=True,viewport={'width':390,'height':844});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(BASE+'#player');page.wait_for_timeout(900)
 ids=['player-h-panel','player-h-timeline','player-h-voice','player-h-guide','player-h-log']
 def tops(ids):return [page.locator('#'+x).bounding_box()['y'] for x in ids]
 positions=tops(ids);assert positions==sorted(positions),positions
 assert page.locator('#player-toolbar #player-start').is_visible()
 assert page.locator('#player-toolbar #player-pip-open').is_visible()
 assert not page.locator('#player-guide').is_visible()
 page.locator('#player-h-guide').locator('..').locator('summary').click();assert page.locator('#player-guide').is_visible()
 page.evaluate('location.hash="setup"');page.wait_for_timeout(600)
 ids=['setup-h-steps','setup-h-checks','setup-h-edit']
 positions=tops(ids);assert positions==sorted(positions),positions
 assert not page.locator('#setup-step-done a').is_visible()
 page.evaluate('location.hash="timeline"');page.wait_for_timeout(200)
 assert page.locator('#player-timeline-select').is_visible();assert page.locator('#player-toolbar').is_visible()
 assert not page.evaluate('document.documentElement.scrollWidth>innerWidth')
 assert not errors,errors
 print('Mobile reading order, grouped playback actions, expandable guide, no premature completion, wizard isolation passed.')
 b.close()
