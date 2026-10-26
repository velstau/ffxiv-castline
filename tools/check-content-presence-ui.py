# Isolated browser observations; no test API is added to production files.
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(args=['--no-sandbox']);page=b.new_page(ignore_https_errors=True);errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 def instrument(route):
  r=route.fetch();source=r.text()+'''
 globalThis.testContentFrame=async(at,name,enemy=true,hp=null)=>{
  state.running=true;state.regionsKey='1920x1080';state.lastContentAt=0;
  state.regions={content:{x:0,y:0,w:100,h:20},enmity:{x:0,y:20,w:100,h:20}};
  state.ocr={readFrame:async()=>({content:{text:name??'',decided:name},hp,enmity:enemy,casts:[]}),scanLines:async()=>[]};
  const c=document.createElement('canvas');c.width=1920;c.height=1080;const ctx=c.getContext('2d');ctx.fillStyle='#808080';ctx.fillRect(0,0,1920,1080);const bitmap=await createImageBitmap(c);
  try{await tick({bitmap,at});return {detected:state.detectedContent,engine:state.engine?.state??null,blocked:state.contentBlocked,muted:state.contentMuted,value:$('timeline-select').value};}finally{bitmap.close();}
 };
 '''
  route.fulfill(response=r,body=source)
 page.route('**/js/player.js',instrument)
 page.goto('https://192.168.11.100:8011/ff14tools/castline/?timelines=site#player');page.wait_for_function('document.querySelectorAll("#player-timeline-select option").length>1');page.wait_for_timeout(1000)
 at=page.evaluate('Date.now()');name='次元の狭間オメガ零式：アルファ編1'
 def frame(delta,name,enemy=True,hp=None):return page.evaluate('(v)=>testContentFrame(...v)',[at+delta,name,enemy,hp])
 r=frame(0,name,False);assert r['detected']==name
 for delta in [1000,2000,3000]:
  r=frame(delta,None);assert r['engine']!='combat',r
 r=frame(7000,None);assert r['engine'] is None and r['detected'] is None and r['value']=='auto',r
 r=frame(8000,None);assert r['engine'] is None
 r=frame(9000,name,False);assert r['detected']==name
 frame(10000,name,False);frame(12000,name,True);r=frame(13000,name,True);assert r['engine']=='combat',r
 frame(14000,None,True,90);r=frame(21000,None,True,89);assert r['engine']=='combat',r
 r=frame(25000,None,True,None);assert r['engine']=='combat' and r['muted'] and not r['blocked'],r
 r=frame(80000,None,True,None);assert r['engine']=='combat' and r['muted'],r
 r=frame(195000,None,True,None);assert r['engine'] is None and r['blocked'] and not r['muted'],r
 assert not errors,errors
 print('Outside/PT text does not start combat; stale timeline clears; reentry restores; real HP preserves combat; in combat, missing evidence mutes speech and clears after 180 s.')
 b.close()
