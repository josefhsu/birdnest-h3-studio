(()=>{'use strict';const $=id=>document.getElementById(id);let busy=false,polling=false,connection=null,cloud=[],timer=null,lastActivity=0;const selected=new Set();
const creator=document.body.dataset.workspace==='creator';
const service=creator?'/api/creator/':'/api/colab/';
const labels={assigning:'申請 GPU',booting:'啟動中',mounting:'連接 Drive',awaiting_drive:'等待 Drive 授權',ready:'可開始創作',uploading:'傳送素材',running:'執行中',stopped:'GPU 已釋放',error:'執行未完成',stop_failed:'需確認釋放'};
const jobLabels={draft:'待送出',queued:'已排程',running:'生成中',done:'已儲存',error:'未完成',cancelled:'已移出排隊'};
function note(message,error=false){$('runtime-message').textContent=message;$('runtime-message').classList.toggle('error',error)}
async function api(path,body){const r=await fetch(path,body===undefined?undefined:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});let d;try{d=await r.json()}catch{throw new Error('伺服器尚未就緒，請稍後重試。')}if(!r.ok){const e=new Error(d.error||'連線失敗');e.status=r.status;throw e}return d}
const post=(action,body={})=>api(service+action,body);
function buttons(){
  const s=connection?.runtime;
  $('sync-jobs').disabled=busy;
  $('run-jobs').disabled=busy||s?.phase!=='ready'||!selected.size;
  $('run-jobs').textContent=creator?'送出一則生成':selected.size?'送出 '+selected.size+' 項工作':'送出待處理工作';
  if(creator)return;
  const active=isActive(s);
  $('deploy-runtime').disabled=busy||!connection?.connected||!!active;
  $('google-connect').disabled=busy;
  $('google-auth-submit').disabled=busy;
  $('stop-runtime').hidden=!active;
  $('stop-runtime').disabled=busy;
  $('retry-assignment').disabled=busy||!connection?.connected;
  $('drive-resume').disabled=busy||polling;
}
const isActive=s=>s&&!['stopped','error'].includes(s.phase);
let awaitingDriveReturn=false;
function renderStatus(data){
  connection=data;
  const runtime=data.runtime;
  if(creator){
    $('runtime-stage').textContent=runtime?.phase==='busy'?'目前忙碌':labels[runtime?.phase]||'服務待命';
    note(runtime?.phase==='ready'?'已就緒。每次可送出一則工作。'
      :runtime?.phase==='busy'?'另一則創作正在處理中，完成後即可送出。'
      :['uploading','running'].includes(runtime?.phase)?'正在處理創作工作。':'創作服務尚未就緒。');
    window.songyinResults?.renderProgress(runtime);
    buttons();
    return;
  }
  document.dispatchEvent(new CustomEvent('studio-gpu-status',{detail:runtime}));
  const active=isActive(runtime);
  if(!data.connected)$('connection-status').textContent='工作室可儲存 · 請連接 Google';
  else if(!active)$('connection-status').textContent='Google 已連接 · GPU 未啟動';
  else if(runtime.phase==='stop_failed')$('connection-status').textContent='Colab 尚未確認釋放 GPU';
  else if(runtime.gpuName){
    const drive=runtime.driveReady?'Drive 已連接':runtime.phase==='awaiting_drive'?'待 Drive 授權':'正在連接 Drive';
    $('connection-status').textContent=runtime.gpu+' 已啟動 · '+drive;
  }else $('connection-status').textContent=runtime.gpu+(runtime.assignmentPaused?' 申請暫停':runtime.phase==='assigning'?' 申請中':' 啟動中');

  $('google-account').textContent=data.email||'';
  $('google-connect').textContent=data.connected?'重新連接 Google':'連接 Google 帳號';
  $('deploy-note').textContent=!data.connected?'先完成 Google 授權，再啟動所選 GPU'
    :active&&runtime.gpuName?runtime.gpuName+' · '+runtime.idleMinutes+' 分鐘閒置自動釋放'
    :runtime?.phase==='assigning'?'這筆申請使用 '+runtime.gpu+' · '+(runtime.assignmentPaused?'申請暫停':'等待 Colab 配發')
    :active?'正在等候 Colab 確認硬體':'按下啟動將使用目前選擇的 GPU';
  $('runtime-stage').textContent=runtime?.phase==='assigning'?runtime.gpu+(runtime.assignmentPaused?' 申請暫停':' 配發中')
    :runtime?labels[runtime.phase]||runtime.phase:'等待連接';
  $('retry-assignment').hidden=!runtime?.assignmentPaused;
  $('stop-runtime').textContent=runtime?.phase==='assigning'?'取消 GPU 申請':'停止並釋放 GPU';
  const memory=[];
  if(active&&runtime.gpuMemoryMiB)memory.push('GPU VRAM '+(runtime.gpuMemoryMiB/1024).toFixed(1)+' GiB');
  if(active&&runtime.hostMemoryKiB)memory.push('主機 RAM '+(runtime.hostMemoryKiB/1048576).toFixed(1)+' GiB');
  if(active&&runtime.stopAt)memory.push('預定釋放 '+new Date(runtime.stopAt).toLocaleString('zh-TW',{hour12:false}));
  $('runtime-memory').hidden=!memory.length;
  $('runtime-memory').textContent=memory.join(' · ');
  $('live-usage').textContent=data.connected&&typeof data.balance==='number'
    ?'即時剩餘 '+data.balance.toLocaleString('zh-TW',{maximumFractionDigits:2})+' CU'+(typeof data.rate==='number'?' · 目前 '+data.rate+' CU／小時':''):'';
  const needsDrive=runtime?.phase==='awaiting_drive'&&Boolean(runtime.driveURL);
  $('drive-auth').hidden=!needsDrive;
  $('drive-access').hidden=!needsDrive;
  if(needsDrive)$('drive-auth-link').href=runtime.driveURL;
  else{
    $('drive-auth-link').removeAttribute('href');
    awaitingDriveReturn=false;
  }
  const logs=runtime?.log||[];
  $('runtime-log').hidden=!logs.length;
  $('runtime-log').textContent=logs.join('\n');
  note(runtime?.message||(data.connected?'Google 已連接，選好 GPU 後即可啟動。':'請連接你的 Google 帳號，授權後會驗證 Colab 點數與可用連線。'),Boolean(runtime?.assignmentPaused));
  window.songyinResults?.renderProgress(runtime);
  buttons();
}
const historyCards=new Map();
const jobKinds={video:'影片',image:'圖片',tts:'配音'};
const resultTypes={video:'video/mp4',image:'image/png',tts:'audio/wav'};

function historyMedia(file,link,options){
  const item=document.createElement('li');
  item.className='ref-card';
  item.append(window.songyinMedia.thumbnail(file,item,options),link);
  return item;
}

function buildHistoryCard(job){
  const standaloneUpscale=job.manifest.operation==='upscale';
  const card=document.createElement('article');
  card.className='job-item';
  const body=document.createElement('div');
  const heading=document.createElement('strong');
  const kind=standaloneUpscale?'影片放大 '+job.manifest.upscale+'×':jobKinds[job.kind]||'創作';
  heading.textContent=kind+' / '+(jobLabels[job.state]||job.state)
    +(job.manifest.seconds?' · '+Number(job.manifest.seconds.toFixed(2))+' 秒':'');
  let choice=null;
  if(!standaloneUpscale&&['draft','error'].includes(job.state)){
    const label=document.createElement('label');
    label.className='job-choice';
    choice=document.createElement('input');
    choice.type=creator?'radio':'checkbox';
    choice.name='run-job';
    choice.setAttribute('aria-label','送出工作：'+job.prompt.slice(0,40));
    choice.addEventListener('change',()=>{
      if(creator)selected.clear();
      if(choice.checked)selected.add(job.id);
      else selected.delete(job.id);
      buttons();
    });
    label.append(choice,heading);
    body.append(label);
  }else body.append(heading);

  const prompt=document.createElement('p');
  prompt.textContent=job.prompt;
  const updated=document.createElement('small');
  const files=job.manifest.files||[];
  updated.textContent=new Date(job.updated_at).toLocaleString('zh-TW')+' · '+files.length+' 個素材';
  body.append(prompt,updated);

  const media=document.createElement('ul');
  media.className='cloud-record-media';
  if(job.result?.file){
    const link=document.createElement('a');
    link.href=(creator?'/creator':'/admin')+'/storage';
    link.textContent='在儲存區查看';
    const type=resultTypes[job.kind];
    if(job.result.archived&&type){
      const source='/api/results/'+encodeURIComponent(job.id);
      const poster=job.kind==='video'&&job.result.hasPoster?source+'?poster=1':undefined;
      const file={name:'生成'+jobKinds[job.kind],type};
      media.append(historyMedia(file,link,{source,poster}));
    }else{
      link.className='asset-link';
      body.append(link);
    }
  }
  for(const file of files){
    const link=document.createElement('a');
    link.href='/api/assets/'+encodeURIComponent(file.id);
    link.textContent=file.name;
    link.download=file.name;
    media.append(historyMedia(file,link));
  }
  if(media.childElementCount)body.append(media);
  if(job.result?.error){
    const error=document.createElement('p');
    error.textContent=job.result.error;
    body.append(error);
  }

  if(standaloneUpscale){
    card.append(body);
    return {card,choice};
  }
  const edit=document.createElement('button');
  edit.type='button';
  edit.textContent='載入編輯';
  edit.addEventListener('click',()=>{
    window.songyinJobs?.loadCloud(job.manifest,job.state);
    window.songyinNavigation.show('create');
    $('job-prompt').focus();
  });
  card.append(body,edit);
  return {card,choice};
}

function renderJobs(jobs){
  const previous=new Set(cloud.map(job=>job.id));
  const byId=new Map(jobs.map(job=>[job.id,job]));
  cloud=jobs;
  window.songyinResults?.renderArchive(jobs,importSavedResult,history,submitUpscale);
  for(const id of selected){
    if(!['draft','error'].includes(byId.get(id)?.state))selected.delete(id);
  }
  for(const job of jobs){
    if(job.state==='draft'&&!previous.has(job.id)&&(!creator||!selected.size))selected.add(job.id);
  }
  const list=$('cloud-jobs');
  for(const [id,record] of historyCards){
    if(byId.has(id))continue;
    window.songyinMedia.clear(record.card);
    record.card.remove();
    historyCards.delete(id);
  }
  if(!jobs.length){
    const empty=document.createElement('p');
    empty.className='queue-empty';
    empty.textContent='尚無雲端工作；先將本機清單同步到網站。';
    list.replaceChildren(empty);
  }else list.querySelector('.queue-empty')?.remove();

  // Polling can update the queue without interrupting an unchanged preview.
  for(const [index,job] of jobs.entries()){
    const signature=JSON.stringify([job.kind,job.state,job.prompt,job.updated_at,job.manifest,job.result]);
    let record=historyCards.get(job.id);
    if(record?.signature!==signature){
      const next=buildHistoryCard(job);
      if(record){
        window.songyinMedia.clear(record.card);
        record.card.replaceWith(next.card);
      }
      record={...next,signature};
      historyCards.set(job.id,record);
    }
    if(record.choice)record.choice.checked=selected.has(job.id);
    if(list.children[index]!==record.card)list.insertBefore(record.card,list.children[index]||null);
  }
  buttons();
}
async function history(){const d=await api('/api/studio');renderJobs(d.jobs)}
function schedule(){
  clearTimeout(timer);
  if(!connection?.connected)return;
  const runtime=connection.runtime;
  const delay=runtime?.assignmentPaused?15000:runtime?.retryAt&&runtime.phase==='assigning'?Math.max(2500,runtime.retryAt-Date.now())
    :['assigning','booting','mounting'].includes(runtime?.phase)?2500:runtime?.phase==='running'?3500:15000;
  timer=setTimeout(refresh,delay);
}
async function submitUpscale(id,factor,requestId){
  if(busy)throw new Error('工作室正在處理另一項操作，請稍後再試。');
  busy=true;
  buttons();
  try{
    return await api('/api/results/'+encodeURIComponent(id),{factor,requestId,confirmed:true});
  }finally{
    busy=false;
    buttons();
    void refresh();
  }
}
async function refresh(){if(busy||polling){schedule();return}polling=true;buttons();try{renderStatus(await api(service+'status'));await history();const runtime=connection?.runtime;if(!creator&&runtime&&!runtime.assignmentPaused&&!(runtime.retryAt>Date.now())&&['assigning','booting','mounting'].includes(runtime.phase)){busy=true;buttons();const d=await post('advance');renderStatus({...connection,runtime:d.runtime})}}catch(e){if(e.status!==409){if(e.status===401){connection={...connection,connected:false};if(!creator)$('connection-status').textContent='請重新連接 Google';buttons()}note(e.message,true)}}finally{busy=false;polling=false;buttons();schedule()}}
async function action(fn,onError=e=>note(e.message,true)){if(busy)return;busy=true;buttons();try{await fn()}catch(e){onError(e)}finally{busy=false;buttons();schedule()}}
$('google-connect')?.addEventListener('click',()=>action(async()=>{const d=await post('auth-start');$('google-auth-link').href=d.url;$('google-auth-form').hidden=false;$('google-auth-code').value='';note('請開啟 Google 授權，再把授權碼或回傳網址貼回鳥巢H3大師。');$('google-auth-form').scrollIntoView({behavior:'smooth',block:'nearest'})}));
$('google-auth-form')?.addEventListener('submit',e=>{e.preventDefault();action(async()=>{const code=$('google-auth-code').value.trim();$('google-auth-code').value='';await post('auth-complete',{code});$('google-auth-form').hidden=true;renderStatus(await api(service+'status'));note('Google 與 Colab 帳號已連接。選好 GPU 後即可啟動。')})});
$('deploy-runtime')?.addEventListener('click',()=>action(async()=>{note('正在檢查點數並準備所選 GPU……');const d=await post('start',{settings:window.songyinSettings.get()});renderStatus({...connection,runtime:d.runtime});const step=await post('advance');renderStatus({...connection,runtime:step.runtime});if(step.runtime?.phase==='mounting'){const mount=await post('advance');renderStatus({...connection,runtime:mount.runtime})}}));
$('retry-assignment')?.addEventListener('click',()=>action(async()=>{
  note('正在重試同一筆 Colab GPU 申請……');
  const result=await post('advance',{recheckAssignment:true});
  renderStatus({...connection,runtime:result.runtime});
}));
$('stop-runtime')?.addEventListener('click',()=>action(async()=>{note('正在停止並確認 GPU 已釋放……');const d=await post('stop');renderStatus({...connection,runtime:d.runtime})}));
function resumeDrive(){
  if(busy||polling||connection?.runtime?.phase!=='awaiting_drive')return;
  awaitingDriveReturn=false;
  return action(async()=>{
    note('正在確認 Drive 授權……');
    const data=await post('drive-resume');
    renderStatus({...connection,runtime:data.runtime});
  });
}
$('drive-auth-link')?.addEventListener('click',()=>{awaitingDriveReturn=true});
window.addEventListener('focus',()=>{if(awaitingDriveReturn)resumeDrive()});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&awaitingDriveReturn)resumeDrive()});
$('drive-resume')?.addEventListener('click',resumeDrive);
$('refresh-connection')?.addEventListener('click',refresh);$('refresh-history').addEventListener('click',()=>action(history));
$('sync-jobs').addEventListener('click',()=>action(async()=>{
  const jobs=window.songyinJobs?.get()||[];
  if(!jobs.length){note('請先加入一項工作。');return}
  const payload=[];
  for(const [index,job] of jobs.entries()){
    const work='工作 '+(index+1)+' / '+jobs.length;
    note('正在同步'+work+'……');
    const files=[];
    for(const [i,file] of job.files.entries()){
      const info={name:file.name,type:file.type,bytes:file.size,duration:file.duration};
      if(!file.blob&&file.id){files.push({...info,id:file.id});continue}
      if(!file.blob)throw new Error('素材「'+file.name+'」已無法讀取，請載入工作後重新加入檔案。');
      const id='asset_'+job.id.slice(4)+'_'+i+(file.uploadId?'_'+file.uploadId:'');
      const bytes=file.blob.size;
      note('正在上傳'+work+'的素材 '+(i+1)+' / '+job.files.length+'：'+file.name);
      try{
        const response=await fetch('/api/assets/'+encodeURIComponent(id),{
          method:'PUT',headers:{'content-type':file.type,'x-asset-size':String(bytes)},body:file.blob
        });
        if(!response.ok){
          const failure=await response.json().catch(()=>null);
          throw new Error(failure?.error||'上傳未完成，請重試同步。');
        }
      }catch(error){
        throw new Error('「'+file.name+'」上傳失敗。'+error.message);
      }
      files.push({...info,id,bytes});
    }
    payload.push({...job,files});
  }
  const done=await api('/api/studio',{jobs:payload});
  await history();
  note('已儲存 '+done.saved+' 項工作。'+(creator?'選擇一則即可送出。':'勾選後即可送出至 Colab。'));
}));
function importSavedResult(id){
  if(creator)return;
  if(connection?.runtime?.phase!=='ready'){
    note('收錄舊作品需要已連接 Drive 的 GPU。請先啟動或等這批工作完成。',true);
    window.songyinNavigation.show('compute');
    $('deploy-runtime').scrollIntoView({behavior:'smooth',block:'center'});
    return;
  }
  return action(async()=>{
    notifyStorage('正在收錄既有作品……');
    await post('import-result',{id});
    await history();
    notifyStorage('作品已收錄，可在鳥巢H3大師播放。');
  },error=>notifyStorage(error.message));
}
let storageNotice;
function notifyStorage(message){
  const toast=$('toast');
  toast.textContent=message;
  toast.hidden=false;
  clearTimeout(storageNotice);
  storageNotice=setTimeout(()=>{toast.hidden=true},5000);
}
$('run-jobs').addEventListener('click',()=>action(async()=>{
  const jobs=cloud.filter(job=>selected.has(job.id));
  if(creator&&jobs.length!==1){note('每次只能送出一則生成工作。',true);return}
  const videos=jobs.filter(job=>job.kind==='video');
  if(videos.length>=2&&!window.confirm('確認送出這批影片？\n'+videos.map((job,index)=>
    `${index+1}. ${job.manifest.seconds} 秒 · ${job.manifest.aspect} · ${job.manifest.resolution}`
  ).join('\n')+'\nGPU：'+connection.runtime.gpu))return;
  window.songyinResults?.renderProgress({phase:'uploading',stage:'uploading'});
  note('正在將工作與素材傳送至 Colab……');
  const interval=setInterval(async()=>{
    try{
      const state=await api(service+'status');
      if(state.runtime?.phase==='uploading')window.songyinResults?.renderProgress(state.runtime);
    }catch{ /* The submission request reports errors. */ }
  },2500);
  try{
    const data=await post('run',{ids:jobs.map(job=>job.id),confirmed:true,
      expected:Object.fromEntries(jobs.map(job=>[job.id,job.manifest.seconds]))});
    renderStatus({...connection,runtime:data.runtime});
    await history();
  }finally{clearInterval(interval)}
}));
function touched(e){if(creator||!e.isTrusted||!['ready','running'].includes(connection?.runtime?.phase)||busy||Date.now()-lastActivity<30000)return;if(e.type==='click'&&!e.target.closest('#job-form,#job-list,[data-gpu],#pictures,#cache,#idle,#sync-jobs,#run-jobs'))return;lastActivity=Date.now();post('activity').catch(()=>{})}
for(const event of ['input','change','click'])document.addEventListener(event,touched,{passive:true});
(async()=>{try{await history()}catch(e){note(e.message,true)}await refresh()})();
})();
