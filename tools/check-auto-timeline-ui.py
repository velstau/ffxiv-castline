# Browser-only instrumentation injects a detected content name; production exports are unchanged.
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(args=['--no-sandbox']);page=b.new_page(ignore_https_errors=True);errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 def instrument(route):
  response=route.fetch();source=response.text();source+='\nglobalThis.testDetectedContent = async (name) => { state.detectedContent = name; await resolveTimeline(); };\n';route.fulfill(response=response,body=source)
 page.route('**/js/player.js',instrument)
 page.goto('https://192.168.11.100:8011/ff14tools/castline/?timelines=site#player');page.wait_for_function('document.querySelectorAll("#player-timeline-select option").length>1')
 alpha1='次元の狭間オメガ零式：アルファ編1';alpha2='次元の狭間オメガ零式：アルファ編3'
 page.evaluate('(name)=>testDetectedContent(name)',alpha1)
 assert page.locator('#player-timeline-select').input_value().endswith('alphascape-v1-0-savage.xml')
 assert '自動選択中' in page.locator('#player-timeline-selection-mode').inner_text()
 first=page.locator('#player-timeline-select').input_value()
 page.evaluate('(name)=>testDetectedContent(name)',alpha2)
 second=page.locator('#player-timeline-select').input_value();assert second.endswith('alphascape-v3-0-savage.xml')
 page.locator('#player-timeline-select').select_option(first);page.wait_for_timeout(150)
 page.evaluate('(name)=>testDetectedContent(name)',alpha2);assert page.locator('#player-timeline-select').input_value()==first
 assert page.locator('#player-timeline-auto').is_visible()
 page.locator('#player-timeline-auto').click();page.wait_for_function('(v)=>document.getElementById("player-timeline-select").value===v',arg=second)
 page.evaluate('(name)=>testDetectedContent(name)','未登録のテストコンテンツ');assert page.locator('#player-timeline-select').input_value()=='auto'
 assert not errors,errors
 print('Detected Alpha1/Alpha3 selection, automatic switching, manual override, return to auto, and missing timeline passed.')
 b.close()
