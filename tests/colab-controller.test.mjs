import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';
const sql=new DatabaseSync(':memory:');
for(const file of ['0000_brief_legion.sql','0001_colab_controller.sql','0002_creator_network.sql','0003_script_lab.sql'])sql.exec(await fs.readFile('drizzle/'+file,'utf8'));
const db={
 prepare(q){return {
  bind(...args){return {
   async first(){return sql.prepare(q).get(...args)||null},
   async all(){return {results:sql.prepare(q).all(...args)}},
   async run(){const result=sql.prepare(q).run(...args);return {meta:{changes:Number(result.changes)}}}
  }}
 }},
 async batch(stmts){return Promise.all(stmts.map(s=>s.run()))}
};
const env={DB:db,ADMIN_GOOGLE_EMAIL:'operator@example.test',COLAB_ENCRYPTION_KEY:Buffer.alloc(32,17).toString('base64'),COLAB_OAUTH_CONFIG:JSON.stringify({installed:{client_id:'test-public-client',client_secret:'test-client-secret'}})};
let requests=[],upstream=()=>{throw Error('unexpected network')};
const context=vm.createContext({console,crypto:webcrypto,TextEncoder,TextDecoder,URL,URLSearchParams,Request,Response,Headers,FormData,AbortController,AbortSignal,DOMException,Uint8Array,ArrayBuffer,DataView,Date,JSON,btoa,atob,setTimeout,clearTimeout,fetch:async(url,init)=>{requests.push({url:String(url),init});return upstream(String(url),init)}});
const modules=new Map();
async function load(filename){if(filename==='cloudflare:workers'){if(!modules.has(filename))modules.set(filename,new vm.SyntheticModule(['env'],function(){this.setExport('env',env)},{context}));return modules.get(filename)}const key=path.resolve(filename);if(modules.has(key))return modules.get(key);if(key.endsWith('?raw')){const txt=await fs.readFile(key.slice(0,-4),'utf8');const mod=new vm.SyntheticModule(['default'],function(){this.setExport('default',txt)},{context,identifier:key});modules.set(key,mod);return mod}const contents=await fs.readFile(key,'utf8');const js=ts.transpileModule(contents,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;const mod=new vm.SourceTextModule(js,{context,identifier:key});modules.set(key,mod);await mod.link(async spec=>spec==='cloudflare:workers'?load(spec):load(path.resolve(path.dirname(key),spec+(/(?:\?raw|\.mjs)$/.test(spec)?'':'.ts'))));return mod}
async function namespace(file){const m=await load(file);if(m.status!=='evaluated')await m.evaluate();return m.namespace}
const auth=await namespace('lib/colab-auth.ts'), control=await namespace('lib/colab-controller.ts'), jupyter=await namespace('lib/colab-jupyter.ts'), route=await namespace('app/api/colab/[action]/route.ts');
let count=0;async function test(name,fn){await fn();count++;console.log('PASS',name)}
await test('OAuth and runtime credentials are encrypted and bound to one owner',async()=>{const encrypted=await auth.seal('owner-a',{refresh_token:'secret-example'});assert(!encrypted.includes('secret-example'));assert.equal((await auth.unseal('owner-a',encrypted)).refresh_token,'secret-example');await assert.rejects(auth.unseal('owner-b',encrypted))});
await test('Provider authorization uses PKCE, offline scope, and registered redirect',async()=>{const result=await auth.beginAuth('owner-a');const u=new URL(result.url);assert.equal(u.origin,'https://accounts.google.com');assert.equal(u.searchParams.get('code_challenge_method'),'S256');assert.equal(u.searchParams.get('access_type'),'offline');assert.equal(u.searchParams.get('redirect_uri'),'https://sdk.cloud.google.com/applicationdefaultauthcode.html');assert.equal(u.searchParams.get('token_usage'),'remote');assert(!result.url.includes('test-client-secret'));assert(!JSON.stringify(result).includes('verifier'))});
await test('Authorization code exchange is one-use and secrets never enter response',async()=>{upstream=(url,init)=>{if(url.includes('oauth2.googleapis.com/token')){const p=new URLSearchParams(init.body);assert.equal(p.get('grant_type'),'authorization_code');assert(p.get('code_verifier'));assert.equal(p.get('code'),'test-authorization-code');return Response.json({access_token:'access-example',refresh_token:'refresh-example',expires_in:3600})}if(url.includes('userinfo'))return Response.json({email:'operator@example.test',verified_email:true});throw Error('unexpected '+url)};const authorize = new URL((await auth.beginAuth('owner-a')).url);
const callback = new URL(authorize.searchParams.get('redirect_uri'));
callback.searchParams.set('code','test-authorization-code');
callback.searchParams.set('state','wrong-attempt');
await assert.rejects(auth.completeAuth('owner-a',callback.href),/另一次授權/);
await assert.rejects(auth.completeAuth('owner-a','https://test.example/callback?code=test-authorization-code'),/回傳網址/);
callback.searchParams.set('state',authorize.searchParams.get('state'));
const result=await auth.completeAuth('owner-a',callback.href);assert.equal(result.email,'operator@example.test');assert(!JSON.stringify(result).includes('example-token'));await assert.rejects(auth.completeAuth('owner-a','test-authorization-code'))});
await test('Missing identity and cross-origin state changes are denied',async()=>{assert.equal((await route.GET(new Request('https://studio.example/api/colab/status'))).status,401);assert.equal((await route.POST(new Request('https://studio.example/api/colab/start',{method:'POST',headers:{'oai-authenticated-user-id':'owner-a',Origin:'https://evil.example'},body:'{}'}))).status,403)});
await test('Concurrent start requests create one saved runtime without GPU allocation',async()=>{requests=[];upstream=url=>{assert(url.includes('ccu-info'));return new Response(")]}'\n"+JSON.stringify({currentBalance:400}))};const settings={gpu:'L4',idle:5,cache:'drive-first',pictures:false};await Promise.all([control.startRuntime('owner-a',settings),control.startRuntime('owner-a',settings)]);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM songyin_colab_runtime').get().n,1);const s=await control.getRuntime('owner-a');assert.equal(s.phase,'assigning');assert.equal(s.nbh.length,44);assert(!requests.some(r=>r.url.includes('/assign?')));await assert.rejects(control.startRuntime('owner-b',{...settings,gpu:'unknown'}))});
await test('Concurrent requests cannot own the same operation lease',async()=>{let unblock;const blocked=new Promise(r=>unblock=r);const first=control.withLock('owner-a',async()=>{await blocked;return 1});await new Promise(r=>setTimeout(r,5));await assert.rejects(control.withLock('owner-a',async()=>2),e=>e.status===409);unblock();assert.equal(await first,1)});
await test('Public status excludes proxy tokens, kernels, and OAuth state',async()=>{const s=await control.getRuntime('owner-a');s.data={proxy:{url:'https://vm.colab.dev',token:'sensitive-proxy'},kernel:'private-kernel',driveRequest:{token:'private'},message:'ready'};const serialized=JSON.stringify(control.publicRuntime(s));for(const forbidden of ['sensitive-proxy','private-kernel','private','nbh'])assert(!serialized.includes(forbidden))});
await test('Proxy URLs reject untrusted hosts and preserve query parameters',async()=>{const u=jupyter.proxyURL({url:'https://vm.colab.dev',token:'proxy-example'},'api/contents/content/h3job/status.json?content=1');assert.equal(u.searchParams.get('content'),'1');assert.equal(u.pathname,'/api/contents/content/h3job/status.json');assert.throws(()=>jupyter.proxyURL({url:'https://evil.example',token:'proxy'},'api/kernels'));assert.throws(()=>jupyter.proxyURL({url:'http://vm.colab.dev',token:'proxy'},'api/kernels'))});
await test('Manifest mapping preserves frame/voice order without user filenames as paths',async()=>{const files=[{id:'asset_a',name:'../first.png'},{id:'asset_b',name:'last.png'}];const frame=control.manifestJob({type:'video',mode:'frames',files});assert.equal(frame.first,'asset_a.png');assert.equal(frame.last,'asset_b.png');const voice=control.manifestJob({type:'tts',files:files.slice(0,1)});assert.equal(voice.voices[0],'asset_a.png')});
await test('Jupyter binary messages and normal JSON frames are decoded',async()=>{const data=JSON.stringify({header:{msg_type:'execute_reply'},content:{status:'ok'}});assert.equal(jupyter.decodeMessage(data).content.status,'ok');const bytes=new TextEncoder().encode(data);const frame=new ArrayBuffer(bytes.length+8);new DataView(frame).setUint32(0,1);new DataView(frame).setUint32(4,8);new Uint8Array(frame,8).set(bytes);assert.equal(jupyter.decodeMessage(frame).content.status,'ok')});
await test('Drive resume completes original consent without repeating the preview',async()=>{
  const s=await control.getRuntime('owner-a');
  const proxy={url:'https://vm.colab.dev',token:'mock-proxy'};
  s.data={...s.data,endpoint:'owned-runtime',kernel:'old-kernel',driveRequest:{old:true},assignedAt:Date.now(),proxy};
  sql.prepare("UPDATE songyin_colab_runtime SET phase='mounting',data=? WHERE owner=?").run(await auth.seal('owner-a',s.data),'owner-a');
  let authorized=false, marker=false, socketCount=0, propagated=false;
  let previewCount=0, tokenCount=0;
  const handlers=new Map();
  let executeHeader;
  const dispatch=(msg_type,content,extra={})=>handlers.get('message')({data:JSON.stringify({header:{msg_type},parent_header:executeHeader,content,...extra})});
  const socket={
    accept(){},
    close(){},
    addEventListener(type,listener){handlers.set(type,listener)},
    send(raw){
      const m=JSON.parse(raw);
      if(m.header.msg_type==='execute_request'){
        executeHeader=m.header;
        queueMicrotask(()=>dispatch('colab_request',{request:{authType:'dfs_ephemeral'}},{metadata:{colab_msg_id:'mount-1'}}));
      }else{
        assert.equal(m.header.msg_type,'input_reply');
        assert.equal(m.content.value.colab_msg_id,'mount-1');
        assert(propagated);
        marker=true;
        queueMicrotask(()=>{
          dispatch('execute_reply',{status:'ok'});
          dispatch('status',{execution_state:'idle'});
        });
      }
    }
  };
  upstream=(raw,init)=>{
    const url=new URL(raw);
    if(url.pathname.endsWith('/assignments'))return Response.json({assignments:[{endpoint:'owned-runtime',runtimeProxyInfo:proxy}]});
    if(url.pathname.endsWith('/drive_ready.json'))return marker?Response.json({format:'text',content:'{"ready":true}'}):new Response(null,{status:404});
    if(url.pathname.includes('/credentials-propagation/')){
      if(init.method==='GET'){
        assert.equal(url.searchParams.get('dryrun'),'true');
        tokenCount++;
        return Response.json({token:'mock-xsrf'});
      }
      assert.equal(init.headers['X-Goog-Colab-Token'],'mock-xsrf');
      if(url.searchParams.get('dryrun')==='false'){
        assert.equal(socketCount,0);
        if(!authorized)return Response.json({success:false,unauthorized_redirect_uri:'https://accounts.google.com/replacement'});
        propagated=true;
        return Response.json({success:true});
      }
      previewCount++;
      return Response.json({success:false,unauthorized_redirect_uri:'https://accounts.google.com/mock-consent'});
    }
    if(url.pathname.endsWith('/api/kernels'))return Response.json({id:'fresh-kernel'});
    if(url.pathname.endsWith('/api/kernels/fresh-kernel/channels')){socketCount++;return {webSocket:socket}}
    if(url.pathname.endsWith('/control.json'))return Response.json({name:'control.json'});
    throw Error('unexpected test route '+url.pathname);
  };
  const pending=await control.advanceRuntime('owner-a');
  assert.equal(pending.runtime.phase,'awaiting_drive');
  const stillPending=await control.advanceRuntime('owner-a',true);
  assert.equal(stillPending.runtime.phase,'awaiting_drive');
  assert.equal(stillPending.runtime.driveURL,pending.runtime.driveURL);
  assert.equal(socketCount,0);
  authorized=true;
  const result=await control.advanceRuntime('owner-a',true);
  assert.equal(result.runtime.phase,'ready');
  assert.equal(result.runtime.driveReady,true);
  assert.equal(socketCount,1);
  assert.equal(previewCount,1);
  assert.equal(tokenCount,1);
  assert.equal((await control.getRuntime('owner-a')).data.driveToken,undefined);
});
await test('Checking a new GPU does not release it before Colab lists the assignment',async()=>{
  const s=await control.getRuntime('owner-a');
  s.data.assignedAt=Date.now();
  sql.prepare("UPDATE songyin_colab_runtime SET phase='booting',data=? WHERE owner=?").run(await auth.seal('owner-a',s.data),'owner-a');
  upstream=url=>url.includes('ccu-info')
    ?Response.json({currentBalance:400,consumptionRateHourly:1.94})
    :Response.json({assignments:[]});
  const result=await control.controllerStatus('owner-a');
  assert.equal(result.runtime.phase,'booting');
  assert.equal((await control.getRuntime('owner-a')).phase,'booting');
});
await test('A live session using the old default migrates to 15 minutes once without resetting the idle clock',async()=>{
  const user='owner-a';
  const proxy={url:'https://vm.colab.dev',token:'mock-proxy'};
  sql.prepare("UPDATE songyin_colab_runtime SET phase='ready',settings=? WHERE owner=?")
    .run(JSON.stringify({gpu:'L4',cache:'drive-first',idle:5}),user);
  const previous={idle_minutes:5,busy:false,last_activity:123};
  let writes=0;
  upstream=(raw,init)=>{
    const path=new URL(raw).pathname;
    if(path.endsWith('/ccu-info'))return Response.json({currentBalance:400});
    if(path.endsWith('/assignments'))return Response.json({assignments:[{endpoint:'owned-runtime',runtimeProxyInfo:proxy}]});
    if(path.endsWith('/control.json')){
      if(init.method==='PUT'){
        writes++;
        const contents=JSON.parse(Buffer.from(JSON.parse(init.body).content,'base64').toString());
        assert.deepEqual(contents,{...previous,idle_minutes:15});
      }
      return Response.json({format:'text',content:JSON.stringify(previous)});
    }
    throw Error('unexpected test route '+path);
  };
  assert.equal((await control.controllerStatus(user)).runtime.idleMinutes,15);
  assert.equal((await control.controllerStatus(user)).runtime.idleMinutes,15);
  assert.equal(writes,1);
});
await test('Session stop touches only the runtime saved for this owner',async()=>{const s=await control.getRuntime('owner-a');s.data.endpoint='owned-runtime';sql.prepare('UPDATE songyin_colab_runtime SET data=? WHERE owner=?').run(await auth.seal('owner-a',s.data),'owner-a');requests=[];upstream=(url,init)=>url.includes('/unassign/owned-runtime')?Response.json(init.method==='GET'?{token:'xsrf-example'}:{}):url.includes('/assignments')?Response.json({assignments:[{endpoint:'unrelated-runtime'}]}):(()=>{throw Error('unexpected '+url)})();const result=await control.stopRuntime('owner-a');assert.equal(result.runtime.phase,'stopped');assert(requests.filter(r=>r.init.method==='POST').every(r=>r.url.includes('/unassign/owned-runtime')))});
await test('G4 timeout recovery finds the same allocation without submitting a second request',async()=>{
  upstream=()=>Response.json({currentBalance:400});
  await control.startRuntime('owner-a',{gpu:'G4',idle:5,cache:'drive-first',highMemory:true});
  const original=await control.getRuntime('owner-a');
  let posts=0;
  let available=false;
  upstream=(uri,init)=>{
    const url=new URL(uri);
    assert.equal(url.searchParams.get('nbh'),original.nbh);
    assert.equal(url.searchParams.get('accelerator'),'G4');
    assert.equal(url.searchParams.has('shape'),false);
    if(init.method==='POST'){posts++;throw new DOMException('simulated delay','TimeoutError')}
    return Response.json(available?{endpoint:'g4-assigned',runtimeProxyInfo:{},accelerator:'G4'}:{token:'new-xsrf'});
  };
  const failed=await control.advanceRuntime('owner-a');
  assert.match(failed.runtime.message,/逾時/);
  assert(failed.runtime.retryAt>Date.now());
  requests=[];
  assert.equal((await control.advanceRuntime('owner-a')).runtime.retryAt,failed.runtime.retryAt);
  assert.equal(requests.length,0);
  const pending=await control.getRuntime('owner-a');
  pending.data.retryAt=Date.now()-1;
  sql.prepare('UPDATE songyin_colab_runtime SET data=? WHERE owner=?').run(await auth.seal('owner-a',pending.data),'owner-a');
  available=true;
  const recovered=await control.advanceRuntime('owner-a');
  assert.equal(recovered.runtime.phase,'booting');
  assert.equal(posts,1);
});
await test('A100 high RAM uses the same profile to apply, pause on 412, and cancel',async()=>{
  sql.prepare("UPDATE songyin_colab_runtime SET phase='stopped' WHERE owner=?").run('owner-a');
  upstream=()=>Response.json({currentBalance:400});
  await control.startRuntime('owner-a',{gpu:'A100',idle:5,cache:'drive-first',highMemory:true});
  const original=await control.getRuntime('owner-a');
  let posts=0;
  upstream=(uri,init)=>{
    const url=new URL(uri);
    assert.equal(url.searchParams.get('nbh'),original.nbh);
    assert.equal(url.searchParams.get('shape'),'hm');
    if(init.method==='POST'){posts++;return new Response('',{status:412})}
    return Response.json({token:'new-xsrf'});
  };
  const paused=await control.advanceRuntime('owner-a');
  assert.equal(paused.runtime.assignmentPaused,true);
  assert.match(paused.runtime.message,/A100 配發（HTTP 412）/);
  assert.equal((await control.advanceRuntime('owner-a')).runtime.assignmentPaused,true);
  assert.equal(posts,1);
  const stopped=await control.stopRuntime('owner-a');
  assert.equal(stopped.runtime.phase,'stopped');
  assert.match(stopped.runtime.message,/已取消/);
  assert.equal(posts,1);
});
await test('Saved media serves only the signed-in owner and supports seeking',async()=>{
  const data=new Uint8Array([1,2,3,4,5,6]);
  const key='owner-a/results/job_test/media';
  const meta={size:data.length,httpMetadata:{contentType:'video/mp4'}};
  env.BUCKET={
    async head(candidate){return candidate===key?meta:null},
    async get(candidate,options){
      if(candidate!==key)return null;
      const range=options?.range;
      return {...meta,body:range?data.slice(range.offset,range.offset+range.length):data};
    }
  };
  const route=await namespace('app/api/results/[id]/route.ts');
  const params=Promise.resolve({id:'job_test'});
  const url='https://studio.example/api/results/job_test';
  const blocked=await route.GET(new Request(url),{params});
  assert.equal(blocked.status,401);
  const other=await route.GET(new Request(url,{headers:{'oai-authenticated-user-id':'owner-b'}}),{params});
  assert.equal(other.status,401);
  const partial=await route.GET(new Request(url,{headers:{'oai-authenticated-user-id':'owner-a',range:'bytes=2-4'}}),{params});
  assert.equal(partial.status,206);
  assert.equal(partial.headers.get('content-range'),'bytes 2-4/6');
  assert.equal(partial.headers.get('content-disposition'),'inline');
  assert.deepEqual([...new Uint8Array(await partial.arrayBuffer())],[3,4,5]);
});
await test('H3 references enforce per-kind limits and bind tags to uploaded files',async()=>{
  const refs=await namespace('public/h3-references.mjs');
  const pic={name:'photo.png',type:'image/png',bytes:100};
  const video={name:'shot.mp4',type:'video/mp4',bytes:100,duration:8};
  const audio={name:'voice.wav',type:'audio/wav',bytes:100,duration:3};
  assert.equal(refs.checkReferences('video','ref','@Image1 <Video 1> @Audio1',[pic,video,audio]),'');
  assert.deepEqual(Array.from(refs.labelAssets([pic,video,audio,pic]),asset=>asset.tag),
    ['@Image(1)','@Video(1)','@Audio(1)','@Image(2)']);
  assert.equal(refs.checkReferences('video','ref','@Image(1) @Video(1) @Audio(1)',[pic,video,audio]),'');
  assert.match(refs.checkReferences('video','ref','@Image(2)',[pic]),/找不到/);
  assert.match(refs.checkReferences('video','ref','@圖片1 @影片2',[pic,video]),/找不到/);
  assert.match(refs.checkReferences('video','ref','@圖片1 @影片1',[pic,video,video]),/合計不得超過 15 秒/);
  assert.match(refs.checkReferences('video','ref','@音訊1',[audio]),/搭配/);
  assert.match(refs.checkReferences('video','ref','@圖片1',Array(10).fill(pic)),/圖片最多 9/);
  const twelve=[...Array(8).fill(pic),...Array(2).fill({...video,duration:4}),audio,audio];
  assert.equal(refs.checkReferences('video','ref','@圖片1',twelve),'');
  assert.match(refs.checkReferences('video','ref','@圖片1',[...twelve,pic]),/合計最多 12/);
  assert.equal(refs.normalizeReferences('Use <Picture 2> and @Video 1'),'Use @圖片2 and @影片1');
  assert.equal(refs.normalizeReferences('@Image(2) @Video(1) @Audio(1)'), '@圖片2 @影片1 @音訊1');
  assert.equal(refs.normalizeReferences('@Audio(1)','model'),'<Audio 1>');
  assert.equal(refs.removeReference('@Image1 / @圖片2 / @Audio1','image',1),' / @圖片1 / @Audio1');
  assert.equal(refs.removeReference('@Image(1) / @Image(2) / @Audio(1)','image',1),' / @Image(1) / @Audio(1)');
  assert.match(control.manifestJob({type:'video',mode:'ref',prompt:'<Picture 1>',files:[{id:'asset_1',name:'photo.png'}]}).prompt,/@圖片1/);
});
await test('Dragging references renumbers by media type without changing which files the prompt names',async()=>{
  const {reorderReferenceTags}=await namespace('public/h3-references.mjs');
  const one={type:'image/png'},two={type:'image/png'},three={type:'image/png'};
  const audio={type:'audio/wav'},video={type:'video/mp4'};
  const before=[one,audio,two,video,three];
  const prompt='@Image(1) @圖片2 <Picture 3> @Picture ( 2 ) @Audio( 1 ) @Video1 @Image(9)';
  assert.equal(reorderReferenceTags(prompt,before,[audio,two,video,three,one]),
    '@Image(3) @圖片1 <Picture 2> @Picture ( 1 ) @Audio( 1 ) @Video1 @Image(9)');
  assert.equal(reorderReferenceTags(prompt,before,[audio,one,two,video,three]),prompt);
});
await test('Text and frame jobs ignore old tags while frame order and Ref2VA validation still apply',async()=>{
  const refs=await namespace('public/h3-references.mjs');
  const pic={id:'asset_1',name:'frame.png',type:'image/png',bytes:10};
  const end={...pic,id:'asset_2',name:'end.png'};
  const audio={id:'asset_3',name:'voice.wav',type:'audio/wav',bytes:10};
  const prompt='向鏡頭轉身 @圖片9，微笑。 @Subject(1)\n保留 @birdstudio\n\n參考素材：@Audio(2)、<Video 1>';
  const cleaned='向镜头转身，微笑。\n保留 @birdstudio';
  assert.equal(refs.checkReferences('video','text',prompt,[]),'');
  assert.equal(refs.checkReferences('video','frames',prompt,[pic,end]),'');
  assert.match(refs.checkReferences('video','frames',prompt,[]),/圖片/);
  assert.match(refs.checkReferences('video','ref',prompt,[pic]),/找不到/);
  assert.deepEqual(Array.from(refs.filesForMode('video','frames',[audio,pic,end,pic])),[pic,end]);
  assert.equal(control.manifestJob({type:'video',mode:'text',prompt,files:[]}).prompt,cleaned);
  const frame=control.manifestJob({type:'video',mode:'frames',prompt,files:[pic,end]});
  assert.equal(frame.prompt,cleaned);
  assert.equal(frame.first,'asset_1.png');
  assert.equal(frame.last,'asset_2.png');
});
await test('H3 prompt translation preserves dialogue, references and original history',async()=>{
  const {planModelPrompt,traditionalPrompt}=await namespace('public/h3-prompt-language.mjs');
  const original='[Shot 1] 鏡頭緩慢推向 @圖片1。\n女主角：別擔心，我會處理。\nA woman says:   "Don’t change my words."\n招牌寫著「臺灣光影」。\n<d>[Japanese] 本当に大丈夫。</d>';
  const job=control.manifestJob({type:'video',mode:'ref',prompt:original,files:[]});
  const plan=JSON.parse(JSON.stringify(job.prompt_translation));
  const source=plan.filter(part=>typeof part!=='string').map(part=>part.translate);
  const literals=plan.filter(part=>typeof part==='string').join('');
  assert(source.some(part=>part.includes('镜头缓慢推向')));
  assert(!source.some(part=>/词|别担心|臺灣光影|大丈夫/u.test(part)));
  for(const kept of ['[Shot 1]','@圖片1','别担心，我会处理。','A woman says:   "Don’t change my words."','「臺灣光影」','<d>[Japanese] 本当に大丈夫。</d>']){
    assert(literals.includes(kept),kept);
  }
  assert.equal(traditionalPrompt(original,'video'),original);
  assert.equal(traditionalPrompt('镜头移动。\n<d>[Mandarin] 请把门关上。</d>','video'),'鏡頭移動。\n<d>[Mandarin] 請把門關上。</d>');
  const tts='Please close the door.\n<d>[Mandarin] 請把門關上。</d>';
  assert.equal(planModelPrompt(tts,'tts').prompt,'Please close the door.\n<d>[Mandarin] 请把门关上。</d>');
  assert.equal(planModelPrompt(tts,'tts').prompt_translation,undefined);
});
await test('Video upscaling accepts only the offered factors and reaches the Colab manifest',async()=>{
  const {validateJob}=await namespace('lib/studio-validation.ts');
  const job={id:'job_upscale',type:'video',mode:'text',resolution:'1080P',seconds:5,aspect:'16:9',prompt:'A misty dawn',files:[]};
  assert.equal(validateJob(job).upscale,undefined);
  for(const upscale of [1.5,2,3,4]){
    assert.equal(control.manifestJob(validateJob({...job,upscale})).upscale,upscale);
  }
  assert.throws(()=>validateJob({...job,upscale:8}),/倍率/);
  assert.throws(()=>validateJob({...job,upscale:2.5}),/倍率/);
});
await test('The selected H3 video LoRA reaches the Colab manifest only for an administrator video',async()=>{
  const {validateJob,extremeRealismVideoLora}=await namespace('lib/studio-validation.ts');
  const job={id:'job_video_lora',type:'video',mode:'text',resolution:'480P',seconds:5,aspect:'16:9',prompt:'A misty dawn',files:[]};
  assert.equal(control.manifestJob(validateJob(job,true)).lora,undefined);
  const selected={...job,lora:extremeRealismVideoLora};
  assert.equal(control.manifestJob(validateJob(selected,true)).lora,extremeRealismVideoLora);
  assert.throws(()=>validateJob(selected),/LoRA/);
  assert.throws(()=>validateJob({...selected,lora:'unlisted'},true),/LoRA/);
  assert.throws(()=>validateJob({...selected,type:'image',size:'1K'},true),/LoRA/);
});
await test('Admin and creator pages separate the controls and creator submission rejects batches',async()=>{
  const {workspacePage}=await namespace('lib/workspace-page.ts');
  const origin='https://studio.example';
  const admin={'oai-authenticated-user-id':'owner-a'};
  const missing={'oai-authenticated-user-id':'owner-b'};
  const adminPage=await workspacePage(new Request(origin+'/admin',{headers:admin}),'admin');
  const adminHtml=await adminPage.text();
  assert.match(adminHtml,/id="runtime-minutes"/);
  assert.match(adminHtml,/id="gpu-clock"/);
  assert.match(adminHtml,/id="job-lora"/);
  assert.doesNotMatch(adminHtml,/data-video-resolution=/);
  const creatorPage=await workspacePage(new Request(origin+'/creator',{headers:admin}),'creator');
  const html=await creatorPage.text();
  assert.match(html,/id="job-upscale"/);
  assert.doesNotMatch(html,/id="job-lora"/);
  assert.match(html,/data-video-resolution="480P" data-video-seconds="15" data-video-upscale="2"/);
  assert.match(html,/id="saved-results"/);
  for(const id of ['gpu','runtime-minutes','gpu-clock','deploy-runtime','google-connect','drive-auth']){
    assert(!html.includes('id="'+id+'"'));
  }
  const loggedOut=await workspacePage(new Request(origin+'/admin',{headers:missing}),'admin');
  const login=await loggedOut.text();
  assert.match(login,/使用 Google 驗證/);
  assert(!login.includes('id="deploy-runtime"'));
  assert.equal((await route.GET(new Request(origin+'/api/colab/status',{headers:missing}))).status,403);
  const creator=await namespace('app/api/creator/[action]/route.ts');
  const batch=new Request(origin+'/api/creator/run',{method:'POST',headers:{...admin,origin},body:JSON.stringify({ids:['one','two']})});
  assert.equal((await creator.POST(batch)).status,400);
});
await test('Shared creator login isolates browsers and networks and cannot unlock the administrator APIs',async()=>{
  env.CREATOR_SHARED_PASSWORD='test-creator-secret';
  const creator=await namespace('app/api/creator/[action]/route.ts');
  const access=await namespace('lib/studio-access.ts');
  const studio=await namespace('app/api/studio/route.ts');
  const workspace=await namespace('lib/workspace-page.ts');
  const origin='https://studio.example';
  const firstIp='203.0.113.10', secondIp='2001:db8::20';
  const edge=(ip=firstIp)=>({'cf-connecting-ip':ip});
  const data=(username,password)=>new URLSearchParams({username,password}).toString();
  const login=(body,headers={origin})=>creator.POST(new Request(origin+'/api/creator/login',{method:'POST',headers,body}));
  const credentials=data('creator','test-creator-secret');
  assert.equal((await login(credentials,{origin:'https://other.example'})).status,403);
  const bad=await login(data('creator','wrong'));
  assert.equal(bad.headers.get('location'),'/creator?login=failed');
  assert.equal(bad.headers.has('set-cookie'),false);
  for(const headers of [{origin,'x-forwarded-for':firstIp},{origin,...edge('999.0.113.10')},{origin,...edge('2a06:98c0:3600::103')}]){
    const unavailable=await login(credentials,headers);
    assert.equal(unavailable.headers.get('location'),'/creator?login=network');
    assert.equal(unavailable.headers.has('set-cookie'),false);
  }
  async function visit(existing='',ip=firstIp){
    const response=await login(credentials,{origin,cookie:existing,...edge(ip)});
    assert.equal(response.status,303);
    assert.equal(response.headers.get('location'),'/creator');
    const set=response.headers.getSetCookie();
    assert.equal(set.length,2);
    assert(set.every(value=>/HttpOnly; Secure; SameSite=Lax/.test(value)));
    return {cookies:set.map(value=>value.split(';')[0]).join('; '),device:set[0].split(';')[0]};
  }
  const first=await visit(), second=await visit();
  const request=(path,s=first,ip=firstIp)=>new Request(origin+path,{headers:{cookie:s.cookies,...edge(ip)}});
  const identity=await access.studioIdentity(request('/creator'));
  assert.equal(identity.role,'creator');
  assert.notEqual(identity.id,(await access.studioIdentity(request('/creator',second))).id);
  assert.equal(identity.id,(await access.studioIdentity(request('/creator',await visit(first.device)))).id);
  assert.equal((await route.GET(request('/api/colab/status'))).status,401);
  assert.equal(await access.studioIdentity(new Request(origin+'/creator',{headers:{cookie:first.device,...edge()}})),null);
  assert.equal(await access.studioIdentity(new Request(origin+'/creator',{headers:{cookie:first.cookies}})),null);
  const landing=await workspace.workspacePage(request('/creator'),'creator');
  const html=await landing.text();
  assert(html.includes('data-draft-scope="'+identity.id+'"'));
  assert(!html.includes('id="deploy-runtime"'));
  assert(!html.includes('管理員後台'));
  const job={id:'job_guestprivate',type:'video',mode:'text',resolution:'1080P',seconds:5,upscale:4,aspect:'16:9',prompt:'guest-only prompt',files:[]};
  const save=await studio.POST(new Request(origin+'/api/studio',{method:'POST',headers:{origin,cookie:first.cookies,...edge()},body:JSON.stringify({jobs:[job]})}));
  assert.equal(save.status,200);
  const saved=JSON.parse(sql.prepare('SELECT manifest FROM songyin_jobs WHERE id=?').get(job.id).manifest);
  assert.deepEqual([saved.resolution,saved.seconds,saved.upscale],['480P',15,2]);
  // Simulate a creator draft saved before the fixed specification was introduced.
  sql.prepare('UPDATE songyin_jobs SET manifest=? WHERE id=?').run(JSON.stringify(job),job.id);
  const pending=(await (await studio.GET(request('/api/studio'))).json()).jobs[0].manifest;
  assert.deepEqual([pending.resolution,pending.seconds,pending.upscale],['480P',15,2]);
  assert.equal((await (await studio.GET(request('/api/studio'))).json()).jobs.length,1);
  assert.equal((await (await studio.GET(request('/api/studio',second))).json()).jobs.length,0);
  assert.equal((await studio.GET(request('/api/studio',first,secondIp))).status,401);
  const moved=await visit(first.device,secondIp);
  assert.notEqual((await access.studioIdentity(request('/creator',moved,secondIp))).id,identity.id);
  assert.equal((await (await studio.GET(request('/api/studio',moved,'2001:0DB8:0:0:0:0:0:0020'))).json()).jobs.length,0);
  const movedBack=await visit(moved.device);
  assert.equal((await (await studio.GET(request('/api/studio',movedBack))).json()).jobs[0].id,job.id);
  const spoofed=request('/api/studio',first,secondIp);
  spoofed.headers.set('x-forwarded-for',firstIp);
  assert.equal((await studio.GET(spoofed)).status,401);
  const unknown=await studio.GET(new Request(origin+'/api/studio'));
  assert.equal(unknown.status,401);
  const runtime=await control.getRuntime('owner-a');
  const proxy={url:'https://vm.colab.dev',token:'mock-runtime'};
  runtime.data={...runtime.data,driveReady:true,endpoint:'shared-vm',kernel:'shared-kernel',proxy};
  sql.prepare("UPDATE songyin_colab_runtime SET phase='ready',data=? WHERE owner=?").run(await auth.seal('owner-a',runtime.data),'owner-a');
  const handlers=new Map();
  let queue;
  const socket={accept(){},close(){},addEventListener(type,listener){handlers.set(type,listener)},send(raw){
    const msg=JSON.parse(raw);
    const receive=(msg_type,content)=>handlers.get('message')({
      data:JSON.stringify({header:{msg_type},parent_header:msg.header,content}),
    });
    queueMicrotask(()=>{receive('stream',{text:'SONGYIN_JOB_STARTED\n'});receive('execute_reply',{status:'ok'});receive('status',{execution_state:'idle'});});
  }};
  upstream=(uri,init)=>{
    const path=new URL(uri).pathname;
    if(path.endsWith('/assignments'))return Response.json({assignments:[{endpoint:'shared-vm',runtimeProxyInfo:proxy}]});
    if(path.endsWith('/channels'))return {webSocket:socket};
    if(init.method==='PUT'&&path.includes('/api/contents/')){
      if(path.endsWith('/manifest.json'))queue=JSON.parse(Buffer.from(JSON.parse(init.body).content,'base64').toString());
      return Response.json({name:path.split('/').at(-1)});
    }
    throw Error('Unexpected route '+path);
  };
  const send=(visitor,ids)=>creator.POST(new Request(origin+'/api/creator/run',{method:'POST',headers:{origin,cookie:visitor.cookies,...edge()},body:JSON.stringify({ids})}));
  assert.equal((await send(second,[job.id])).status,409);
  const ran=await send(first,[job.id]);
  assert.equal(ran.status,200,await ran.clone().text());
  assert.equal(queue.jobs[0].id,job.id);
  assert.deepEqual([queue.jobs[0].resolution,queue.jobs[0].seconds,queue.jobs[0].upscale],['480P',15,2]);
  assert.equal((await control.getRuntime('owner-a')).data.jobOwner,identity.id);
  const guestJobs=await (await studio.GET(request('/api/studio'))).json();
  assert.equal(guestJobs.jobs[0].state,'queued');
  const otherState=await (await creator.GET(request('/api/creator/status',second))).json();
  assert.deepEqual(otherState.runtime,{phase:'busy'});
});
await test('A legacy device can still open its original works from the first IP it logs in with',async()=>{
  const creator=await namespace('app/api/creator/[action]/route.ts');
  const access=await namespace('lib/studio-access.ts');
  const origin='https://studio.example';
  const id='creator-0cc37363-3cd0-4c6b-8ca3-ef7159e7c858';
  const record={id,expires:Date.now()+86400000};
  const legacyDevice='__Host-h3-device='+await auth.seal('h3-creator-device-v1',record);
  const legacySession='__Host-h3-creator='+await auth.seal('h3-creator-session-v1',record);
  const identity=(ip,cookie)=>access.creatorIdentity(new Request(origin+'/creator',{headers:{'cf-connecting-ip':ip,cookie}}));
  async function login(ip){
    const response=await creator.POST(new Request(origin+'/api/creator/login',{
      method:'POST',headers:{origin,'cf-connecting-ip':ip,cookie:legacyDevice},
      body:new URLSearchParams({username:'creator',password:'test-creator-secret'}),
    }));
    assert.equal(response.headers.get('location'),'/creator');
    return response.headers.getSetCookie()[1].split(';')[0];
  }
  const initialIp='203.0.113.15', otherIp='203.0.113.20';
  assert.equal(await identity(initialIp,legacySession),null);
  assert.equal((await identity(initialIp,await login(initialIp))).id,id);
  assert.notEqual((await identity(otherIp,await login(otherIp))).id,id);
  assert.equal((await identity(initialIp,await login(initialIp))).id,id);
});
await test('Saved video upscaling checks the owner, confirmation and role and submits the original bytes once',async()=>{
  const target=await namespace('app/api/results/[id]/route.ts');
  const creator=await namespace('app/api/creator/[action]/route.ts');
  const access=await namespace('lib/studio-access.ts');
  const origin='https://studio.example', edge={'cf-connecting-ip':'203.0.113.30'};
  const login=await creator.POST(new Request(origin+'/api/creator/login',{
    method:'POST',headers:{origin,...edge},
    body:new URLSearchParams({username:'creator',password:'test-creator-secret'}),
  }));
  const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const headers={origin,cookie,...edge};
  const guest=await access.creatorIdentity(new Request(origin+'/creator',{headers}));
  const fixtures={guest:'job_upscale_guest_source',admin:'job_upscale_admin_source'};
  for(const [id,owner] of [[fixtures.guest,guest.id],[fixtures.admin,'owner-a']]){
    const manifest={id,type:'video',mode:'text',seconds:9,resolution:'480P',files:[]};
    const result={file:id+'.mp4',bytes:3,archived:true,media:{duration:9.04,width:864,height:480}};
    sql.prepare("INSERT INTO songyin_jobs(id,owner,kind,prompt,manifest,state,result,created_at,updated_at) VALUES(?,?,'video','Source',?,'done',?,1,1)")
      .run(id,owner,JSON.stringify(manifest),JSON.stringify(result));
  }
  const ready=async()=>{
    const runtime=await control.getRuntime('owner-a');
    runtime.data={...runtime.data,driveReady:true,endpoint:'shared-vm',kernel:'shared-kernel',proxy:{url:'https://vm.colab.dev',token:'mock-runtime'}};
    sql.prepare("UPDATE songyin_colab_runtime SET phase='ready',data=? WHERE owner=?").run(await auth.seal('owner-a',runtime.data),'owner-a');
  };
  await ready();
  const requests=[], transfers=[], manifests=[];
  env.BUCKET={
    async head(){return {size:3}},
    async get(key){transfers.push(key);return {arrayBuffer:async()=>Uint8Array.of(3,7,11).buffer}},
  };
  const listeners=new Map();
  const socket={accept(){},close(){},addEventListener(type,listener){listeners.set(type,listener)},send(raw){
    const msg=JSON.parse(raw);
    const emit=(type,content)=>listeners.get('message')({
      data:JSON.stringify({header:{msg_type:type},parent_header:msg.header,content}),
    });
    queueMicrotask(()=>{emit('stream',{text:'SONGYIN_JOB_STARTED\\n'});emit('execute_reply',{status:'ok'});emit('status',{execution_state:'idle'});});
  }};
  upstream=(uri,init)=>{
    const path=new URL(uri).pathname;
    if(path.endsWith('/assignments'))return Response.json({assignments:[{endpoint:'shared-vm',runtimeProxyInfo:{url:'https://vm.colab.dev',token:'mock-runtime'}}]});
    if(path.endsWith('/channels'))return {webSocket:socket};
    if(init.method==='PUT'&&path.includes('/api/contents/')){
      const content=Buffer.from(JSON.parse(init.body).content,'base64');
      if(path.endsWith('/manifest.json'))manifests.push(JSON.parse(content.toString()));
      if(path.includes('/inputs/'))requests.push([...content]);
      return Response.json({name:path.split('/').at(-1)});
    }
    throw Error('Unexpected route '+path);
  };
  const firstId='f8e89d29-a8ef-430d-963f-1cf8954c0e42', adminId='1d5a89e2-8a75-472a-a86a-71b95e89a54e';
  const submit=(id,input,who=headers)=>target.POST(new Request(origin+'/api/results/'+id,{
    method:'POST',headers:who,body:JSON.stringify(input),
  }),{params:Promise.resolve({id})});
  assert.equal((await submit(fixtures.guest,{factor:2,confirmed:true,requestId:firstId},{origin})).status,401);
  assert.equal((await submit(fixtures.guest,{factor:2,requestId:firstId})).status,400);
  assert.equal((await submit(fixtures.guest,{factor:3,confirmed:true,requestId:firstId})).status,400);
  assert.equal((await submit(fixtures.admin,{factor:2,confirmed:true,requestId:firstId})).status,404);
  const request={factor:2,confirmed:true,requestId:firstId};
  const sent=await submit(fixtures.guest,request);
  assert.equal(sent.status,202,await sent.clone().text());
  const {id}=await sent.json();
  assert.equal(id,'job_upscale_'+firstId);
  assert.equal((await submit(fixtures.guest,request)).status,202);
  assert.equal(manifests.length,1);
  assert.deepEqual(manifests[0].jobs,[{id,type:'video',operation:'upscale',source:id+'_source.mp4',upscale:2,seconds:9.04}]);
  assert.deepEqual(requests,[[3,7,11]]);
  assert.deepEqual(transfers,[guest.id+'/results/'+fixtures.guest+'/media']);
  assert.equal(sql.prepare('SELECT state FROM songyin_jobs WHERE id=?').get(fixtures.guest).state,'done');
  await ready();
  const admin=await submit(fixtures.admin,{factor:3,confirmed:true,requestId:adminId},{origin,'oai-authenticated-user-id':'owner-a'});
  assert.equal(admin.status,202,await admin.clone().text());
  assert.equal(manifests[1].jobs[0].upscale,3);
});
await test('GPU limit accepts 30 minutes to six hours and starts at assignment',async()=>{
  const settings={gpu:'L4',cache:'drive-first',idle:15};
  for(const runtimeMinutes of [30,60,90,120,180,240,300,360]){
    const selection=control.validateSettings({...settings,runtimeMinutes});
    const before=control.publicRuntime({settings:selection,phase:'assigning',data:{createdAt:10000}});
    assert.equal(before.assignedAt,null);
    assert.equal(before.stopAt,null);
    const after=control.publicRuntime({settings:selection,phase:'ready',data:{createdAt:10000,assignedAt:100000}});
    assert.equal(after.assignedAt,100000);
    assert.equal(after.stopAt,100000+runtimeMinutes*60000);
    assert.equal(typeof after.checkedAt,'number');
  }
  assert.throws(()=>control.validateSettings({...settings,runtimeMinutes:420}),/上限/);
});
await test('Workspace URLs open the correct page and protect administrator pages',async()=>{
  const adminPage=await namespace('app/admin/[section]/route.ts');
  const creatorPage=await namespace('app/creator/[section]/route.ts');
  const origin='https://studio.example';
  const adminHeaders={'oai-authenticated-user-id':'owner-a'};
  for(const [section,label] of [['create','創作'],['compute','運算'],['storage','儲存'],['history','記錄'],['queue','排隊']]){
    const page=await adminPage.GET(new Request(origin+'/admin/'+section,{headers:adminHeaders}),{params:Promise.resolve({section})});
    assert.equal(page.status,200);
    const html=await page.text();
    assert(html.includes('<title>'+label+'｜鳥巢H3大師</title>'));
    assert(html.includes('data-section="'+section+'" class="active" aria-current="page"'));
    assert(html.includes('data-show-on="create"'+(section==='create'?'><div':' hidden')));
  }
  const guest=await creatorPage.GET(new Request(origin+'/creator/storage',{headers:adminHeaders}),{params:Promise.resolve({section:'storage'})});
  const html=await guest.text();
  assert(html.includes('data-active-section="storage"'));
  assert(!html.includes('data-section="queue"'));
  assert(!html.includes('data-section="compute"'));
  assert(!html.includes('id="generation-queue"'));
  assert(!html.includes('id="script-lab-manage"'));
  assert(!html.includes('/script-lab-editor.js'));
  assert(html.includes('value="custom"'));
  assert(html.includes('<option value="night-city">夜城2077 超夢</option>'));
  assert(!html.includes('name="library"'));
  assert.equal((await creatorPage.GET(new Request(origin+'/creator/queue'),{params:Promise.resolve({section:'queue'})})).status,404);
  const loggedOut=await creatorPage.GET(new Request(origin+'/creator/history'),{params:Promise.resolve({section:'history'})});
  assert((await loggedOut.text()).includes('name="section" value="history"'));
  const protectedPage=await adminPage.GET(new Request(origin+'/admin/queue'),{params:Promise.resolve({section:'queue'})});
  assert.equal(new URL(protectedPage.headers.get('location')).searchParams.get('return_to'),'/admin/queue');
});
await test('The administrator queue shows waiting items and only removes work accepted by the runtime',async()=>{
  const origin='https://studio.example', url=origin+'/api/colab/queue';
  const headers={origin,'oai-authenticated-user-id':'owner-a'};
  const runtime=await control.getRuntime('owner-a');
  const ids=['job_active_fixture','job_waiting_one','job_waiting_two','job_finished_fixture'];
  const batchId='queue-test-batch';
  const states=Object.fromEntries(ids.map((id,index)=>[id,{status:['running','queued','queued','done'][index]}]));
  const proxy={url:'https://vm.colab.dev',token:'mock-runtime'};
  runtime.data={...runtime.data,endpoint:'queue-vm',kernel:'queue-kernel',batchStarted:Date.now(),
    jobIds:ids,jobOwner:'creator-fixture',queueBatchId:batchId,status:undefined,proxy};
  sql.prepare("UPDATE songyin_colab_runtime SET phase='running',data=? WHERE owner=?").run(await auth.seal('owner-a',runtime.data),'owner-a');
  for(const id of ids)sql.prepare("INSERT INTO songyin_jobs(id,owner,kind,prompt,manifest,state,created_at,updated_at) VALUES(?,?,'video','Demo prompt',?,'queued',1,1)")
    .run(id,'creator-fixture',JSON.stringify({seconds:15}));
  const listeners=new Map();
  const socket={accept(){},close(){},addEventListener(type,listener){listeners.set(type,listener)},send(raw){
    const msg=JSON.parse(raw);
    const targets=JSON.parse(msg.content.code.match(/cancel_pending\(root,"queue-test-batch",(\[[^\n]*?\])/)[1]);
    const removed=targets.filter(id=>states[id].status==='queued');
    const skipped=targets.filter(id=>!removed.includes(id));
    for(const id of removed)states[id].status='cancelled';
    const emit=(type,content)=>listeners.get('message')({data:JSON.stringify({header:{msg_type:type},parent_header:msg.header,content})});
    queueMicrotask(()=>{
      emit('stream',{text:'SONGYIN_QUEUE='+JSON.stringify({removed,skipped})+'\n'});
      emit('execute_reply',{status:'ok'});
      emit('status',{execution_state:'idle'});
    });
  }};
  upstream=(uri)=>{
    const path=new URL(uri).pathname;
    if(path.endsWith('/status.json'))return Response.json({format:'text',content:JSON.stringify({queue_id:batchId,started:Date.now()/1000,jobs:states})});
    if(path.endsWith('/assignments'))return Response.json({assignments:[{endpoint:'queue-vm',runtimeProxyInfo:proxy}]});
    if(path.endsWith('/channels'))return {webSocket:socket};
    throw Error('Unexpected path '+path);
  };
  const get=()=>route.GET(new Request(url,{headers}));
  const remove=(body,who=headers)=>route.POST(new Request(url,{method:'POST',headers:who,body:JSON.stringify(body)}));
  assert.equal((await route.GET(new Request(url))).status,401);
  assert.equal((await route.GET(new Request(url,{headers:{'oai-authenticated-user-id':'owner-b'}}))).status,403);
  assert.equal((await remove({all:true,batchId},{origin,'oai-authenticated-user-id':'owner-b'})).status,403);
  const before=await (await get()).json();
  assert.equal(before.batchId,batchId);
  assert.deepEqual(before.items.map(job=>job.id),ids.slice(1,3));
  assert.equal((await remove({all:true,batchId:'old-batch'})).status,409);
  assert.deepEqual(await (await remove({id:ids[0],batchId})).json(),{removed:0,skipped:1});
  assert.deepEqual(await (await remove({id:ids[1],batchId})).json(),{removed:1,skipped:0});
  assert.deepEqual(await (await get()).json().then(data=>data.items.map(job=>job.id)),[ids[2]]);
  assert.deepEqual(await (await remove({all:true,batchId})).json(),{removed:1,skipped:2});
  assert.deepEqual(await (await get()).json().then(data=>data.items),[]);
  assert.deepEqual(ids.map(id=>sql.prepare('SELECT state FROM songyin_jobs WHERE id=?').get(id).state),
    ['queued','cancelled','cancelled','queued']);
});
await test('Custom script lab separates draft, publication and access permissions',async()=>{
  const api=await namespace('app/api/script-lab/route.ts');
  const creator=await namespace('app/api/creator/[action]/route.ts');
  const origin='https://studio.example', url=origin+'/api/script-lab';
  const admin={origin,'oai-authenticated-user-id':'owner-a'};
  const edge={'cf-connecting-ip':'203.0.113.48'};
  const login=await creator.POST(new Request(origin+'/api/creator/login',{
    method:'POST',headers:{origin,...edge},
    body:new URLSearchParams({username:'creator',password:'test-creator-secret'}),
  }));
  const cookie=login.headers.getSetCookie().map(part=>part.split(';')[0]).join('; ');
  const guest={...edge,origin,cookie};
  const read=(headers,scope='')=>api.GET(new Request(url+scope,{headers}));
  const write=(body,headers=admin)=>api.POST(new Request(url,{method:'POST',headers,body:JSON.stringify(body)}));
  const id='c3123211-9a50-4a6f-80e0-bf12fa3ec48b';
  const original='  霓虹映在深藍的海面。\n鏡頭慢慢推進。  ';
  const payload={id,revision:0,group:'光影設計',label:'海岸的極光',text:original};
  assert.equal((await read({})).status,401);
  assert.equal((await read(guest,'?admin=1')).status,403);
  assert.equal((await write({...payload,action:'publish'},guest)).status,403);
  assert.equal((await write({...payload,action:'publish'},{...admin,origin:'https://example.invalid'})).status,403);
  assert.equal((await write({...payload,action:'publish',text:'   '})).status,400);

  const created=await write({...payload,action:'save'});
  assert.equal(created.status,200);
  const {item:draft}=await created.json();
  assert.equal(draft.published,false);
  assert.equal(draft.text,original);
  assert.deepEqual((await (await read(guest)).json()).items,[]);

  const published=await write({...payload,action:'publish',revision:draft.revision});
  assert.equal(published.status,200);
  const {item:live}=await published.json();
  const firstView=await (await read(guest)).json();
  assert.equal(firstView.groups['光影設計'],'光影設計');
  assert.deepEqual(firstView.items,[{id,group:payload.group,label:payload.label,text:original}]);

  const edited=await write({...payload,action:'save',revision:live.revision,text:'下一次上架才出現'});
  assert.equal(edited.status,200);
  const {item:next}=await edited.json();
  assert.equal(next.hasUnpublishedChanges,true);
  const {items} = await (await read(admin,'?admin=1')).json();
  assert.equal(items[0].text,'下一次上架才出現');
  assert.equal((await (await read(guest)).json()).items[0].text,original);
  assert.equal((await write({id,revision:live.revision,action:'unpublish'})).status,409);

  const removed=await write({id,revision:next.revision,action:'unpublish'});
  assert.equal(removed.status,200);
  const {item:retained}=await removed.json();
  assert.equal(retained.text,'下一次上架才出現');
  assert.deepEqual((await (await read(guest)).json()).items,[]);
  assert.equal((await write({...retained,action:'publish'})).status,200);
  assert.equal((await (await read(guest)).json()).items[0].text,retained.text);

  const libraries=['fight','scenario','worldview','trapped','night-city','special-props'];
  const originalPublished=(await (await read(guest,'?library=custom')).json()).items;
  assert(originalPublished.some(item=>item.id===id));
  assert.equal((await read(guest,'?library=invalid')).status,400);
  assert.equal((await write({...payload,library:'constructor',action:'publish'})).status,400);
  for(const [index,library] of libraries.entries()){
    const categoryId='a798c20d-ff59-488b-a47f-5488ea0f429'+index;
    const create={...payload,id:categoryId,library,group:'',label:'測試條目 '+library};
    const saved=await write({...create,action:'publish'});
    assert.equal(saved.status,200,library);
    const {item}=await saved.json();
    const other=library==='night-city'?'worldview':'night-city';
    const response=await (await read(guest,'?library='+library)).json();
    assert.deepEqual(response.items,[{id:categoryId,group:'自訂條目',label:create.label,text:original}]);
    assert(!((await (await read(guest,'?library='+other)).json()).items.some(entry=>entry.id===categoryId)));
    assert.deepEqual((await (await read(guest)).json()).items,originalPublished);
    if(library==='night-city'){
      const draftMove=await write({...create,library:'scenario',action:'save',revision:item.revision});
      assert.equal(draftMove.status,200);
      const {item:changed}=await draftMove.json();
      assert.equal(changed.library,'scenario');
      assert.equal(changed.hasUnpublishedChanges,true);
      assert.equal((await (await read(guest,'?library=night-city')).json()).items[0].id,categoryId);
      const publishMove=await write({...changed,action:'publish'});
      assert.equal(publishMove.status,200);
      const {item:moved}=await publishMove.json();
      assert.deepEqual((await (await read(guest,'?library=night-city')).json()).items,[]);
      assert((await (await read(guest,'?library=scenario')).json()).items.some(entry=>entry.id===categoryId));
      const removed=await write({id:categoryId,revision:moved.revision,action:'unpublish'});
      assert.equal(removed.status,200);
      assert(!((await (await read(guest,'?library=scenario')).json()).items.some(entry=>entry.id===categoryId)));
    }
  }
});
console.log(`${count} controller tests passed; upstream responses mocked, no real GPU used.`);
