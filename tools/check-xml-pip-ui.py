# Requires Python Playwright and its Chromium browser. Uses an isolated browser context.
# Optional argument: Castline development base URL (HTTPS or localhost).
import sys
BASE = (sys.argv[1] if len(sys.argv) > 1 else 'https://192.168.11.100:8011/ff14tools/castline/').rstrip('/') + '/'
from playwright.sync_api import sync_playwright
from pathlib import Path
with sync_playwright() as p:
 b=p.chromium.launch(args=['--no-sandbox']);page=b.new_page(ignore_https_errors=True,viewport={'width':1440,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(BASE+'#manage')
 page.locator('a[data-focus="player-local-file"]').click();page.wait_for_timeout(600)
 assert page.locator('#player-local-file').is_visible()
 xml=b'<?xml version="1.0"?><timeline><format>castline/1</format><content>Test content</content><title>UI regression</title><phase id="p1"><entry t="6.0" text="Raidwide" castname="Test cast" duration="5.0" /></phase></timeline>'
 page.locator('#player-local-file').set_input_files({'name':'ui-regression.xml','mimeType':'application/xml','buffer':xml});page.wait_for_timeout(500)
 assert page.locator('#player-timeline-select').input_value()=='local:ui-regression.xml'
 assert 'ui-regression.xml' in page.locator('#player-timeline-status').inner_text()
 page.evaluate('location.hash="manage"');page.wait_for_timeout(200);page.evaluate('location.hash="player"');page.wait_for_timeout(300)
 assert page.locator('#player-timeline-select').input_value()=='local:ui-regression.xml'
 if page.evaluate("'documentPictureInPicture' in window"):
  page.locator('#player-pip-open').click();page.wait_for_timeout(800)
  print('PIP', page.evaluate('''()=>{const w=documentPictureInPicture.window;return {opened:!!w,theme:w?.document.documentElement.dataset.bsTheme,styles:w?[...w.document.styleSheets].length:0}}'''))
  assert page.evaluate('!!documentPictureInPicture.window')
  page.evaluate('window.previousPip=documentPictureInPicture.window')
  page.locator('#player-pip-open').click();page.wait_for_timeout(200)
  assert page.evaluate('window.previousPip===documentPictureInPicture.window'), 'PiP was unnecessarily recreated'
  page.evaluate('documentPictureInPicture.window.close()')
 # 「次にすること」の「手元の XML を選ぶ」から、ファイルを選ぶ窓を出して読み込める
 page.evaluate('location.hash="player"');page.wait_for_timeout(300)
 assert page.locator('#player-guide-timeline #player-guide-xml').is_visible()
 with page.expect_file_chooser() as fc: page.locator('#player-guide-xml').click()
 fc.value.set_files({'name':'guide-pick.xml','mimeType':'application/xml','buffer':xml.replace(b'UI regression',b'Guide pick')});page.wait_for_timeout(500)
 assert page.locator('#player-timeline-select').input_value()=='local:guide-pick.xml'
 page.wait_for_function('document.querySelector("#player-guide-timeline [data-guide-state]").textContent.includes("自分で選んだ")',timeout=5000)
 page.locator('#theme-toggle').click();assert page.locator('html').get_attribute('data-bs-theme')=='light'
 page.goto(BASE+'setup.html');page.wait_for_timeout(200);assert page.url.endswith('/#setup')
 print('XML import, retained selection, theme, old URL redirect passed. Errors:',errors)
 assert not errors
 b.close()
