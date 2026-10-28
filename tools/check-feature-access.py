import sys
from playwright.sync_api import sync_playwright
from pathlib import Path
import subprocess
base=(sys.argv[1] if len(sys.argv)>1 else 'https://192.168.11.100:8011/ff14tools/castline/').rstrip('/')+'/'
with sync_playwright() as p:
 b=p.chromium.launch(args=['--no-sandbox']);page=b.new_page(ignore_https_errors=True,viewport={'width':1440,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(base+'#player')
 page.wait_for_function('document.querySelectorAll("#player-timeline-select option").length>1',timeout=15000)
 assert page.locator('#player-timeline-select').is_visible()
 assert page.locator('#player-tts').is_visible()
 options=page.locator('#player-timeline-select option').count();print('Timeline choices',options)
 cloud=page.locator('#player-timeline-select option[value^="cloud:"]').first.get_attribute('value')
 page.locator('#player-timeline-select').select_option(cloud)
 page.wait_for_function('document.querySelector("#player-panel [data-k=head]").textContent!=="タイムラインがありません"')
 selected=page.locator('#player-timeline-select').input_value()
 page.locator('#player-tts').uncheck();assert not page.locator('#player-tts').is_checked()
 page.locator('#player-tts-engine').select_option('voicevox');assert page.locator('#player-voicevox-url').is_visible();page.locator('#player-tts-engine').select_option('browser')
 page.locator('#player-pip-font').select_option('custom');assert page.locator('#player-pip-font-name').is_visible();page.locator('#player-pip-font').select_option('');assert not page.locator('#player-pip-font-name').is_visible()
 page.evaluate('location.hash="manage"');page.wait_for_timeout(200);page.evaluate('location.hash="player"');page.wait_for_timeout(200)
 assert page.locator('#player-timeline-select').input_value()==selected
 page.evaluate('location.hash="recorder"');page.wait_for_timeout(600)
 radios=page.locator('input[name="recorder-mode"]');print('Recorder modes',radios.count())
 page.locator('input[name="recorder-mode"][value="fix"]').check();assert page.locator('#recorder-timeline-field').is_visible()
 page.locator('input[name="recorder-mode"][value="new"]').check();assert page.locator('#recorder-content-field').is_visible()
 page.locator('input[name="recorder-input"][value="screen"]').check();assert page.locator('#recorder-screen-field').is_visible()
 page.locator('input[name="recorder-input"][value="file"]').check();assert page.locator('#recorder-file-field').is_visible()
 page.evaluate('location.hash="generator"');page.wait_for_timeout(400)
 for id in ['key-id','key-secret','key-save','key-clear','report-url','report-load']:
  assert page.locator('#generator-'+id).is_visible(),id
 page.locator('#generator-key-id').fill('ui-test');page.locator('#generator-key-secret').fill('ui-test');page.locator('#generator-key-save').click();assert '保存' in page.locator('#generator-key-status').inner_text();page.locator('#generator-key-clear').click()
 page.evaluate('location.hash="lab"');page.wait_for_timeout(400)
 for id in ['file-input','capture-start','watch-start','region-picker','read-all']:
  assert page.locator('#lab-'+id).is_visible(),id
 page.set_viewport_size({'width':390,'height':844});page.evaluate('location.hash="player"');page.wait_for_timeout(200)
 assert page.locator('#player-timeline-select').is_visible()
 assert not page.evaluate('document.documentElement.scrollWidth>innerWidth')
 print('Existing timeline selection, playback preferences, recorder modes/inputs, FFLogs settings, OCR diagnostics reachable. Errors:',errors)
 assert not errors
 b.close()
