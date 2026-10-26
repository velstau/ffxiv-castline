# Tests inject observations only into the browser response; production code has no test API.
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(args=['--no-sandbox']);page=b.new_page(ignore_https_errors=True);errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 def instrument(route):
  r=route.fetch();s=r.text()+'''
 globalThis.testPlaybackEnd = async (hud, intermediate=false) => {
   const timeline={phases:[{id:'p1',entries:[],next:intermediate?[{to:'p2',when:{time:100}}]:[]}]};
   const e=new TimelineEngine(timeline,{hasEnmity:true});
   const at=Date.now();e.started(at-4500);e.hpPercent(at-3500, null);e.enmity(at-3000,false);
   state.engine=e;state.running=true;state.regionsKey='1920x1080';
   state.regions={content:{x:0,y:0,w:100,h:20},enmity:{x:0,y:20,w:100,h:20}};
   const original=state.ocr;
   state.clearNoticeFight=null;state.clearNotice.reset();state.ocr={scanLines:async()=>hud?[{text:'DUTY COMPLETE'}]:[],readFrame:async(frame,regions,want)=>want.content?{content:{text:hud},casts:[]}:{hp:null,enmity:false,casts:[]}};
   const c=document.createElement('canvas');c.width=1920;c.height=1080;const ctx=c.getContext('2d');ctx.fillStyle='#808080';ctx.fillRect(0,0,1920,1080);
   const bitmap=await createImageBitmap(c);
   try{await tick({bitmap,at:at-1000});await tick({bitmap,at});return e.status(at).state;}
   finally{bitmap.close();state.running=false;state.ocr=original;state.engine=null;}
 };
 '''
  route.fulfill(response=r,body=s)
 page.route('**/js/player.js',instrument)
 page.goto('https://192.168.11.100:8011/ff14tools/castline/?timelines=site#player');page.wait_for_function('typeof testPlaybackEnd==="function"');page.wait_for_timeout(400)
 assert page.evaluate('testPlaybackEnd("コンテンツ情報")')=='ended'
 assert page.evaluate('testPlaybackEnd("")')=='combat'
 assert page.evaluate('testPlaybackEnd("コンテンツ情報",true)')=='ended'
 assert not errors,errors
 print('Playback tick: completion banner ends without HP, no banner continues, explicit clear works even in an intermediate XML phase.')
 b.close()
