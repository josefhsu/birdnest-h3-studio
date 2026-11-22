import {env} from 'cloudflare:workers';
import {db,now,seal,unseal,colab,release,ControlError,authRow,configured} from './colab-auth';
import {execute,remote,writeFile,readJSON,Proxy} from './colab-jupyter';
import {checkReferences,normalizeReferences,submissionPrompt} from '../public/h3-references.mjs';
import {planModelPrompt,traditionalPrompt} from '../public/h3-prompt-language.mjs';
import {archiveResult,jobIdPattern,lawfulFile,mediaKey,types} from './studio-media';
import {applyCreatorVideoSettings,creatorVideoSettings,isVideoUpscaleFactor} from './studio-validation';
import type {Identity} from './studio-access';
import mediaMetadata from './colab-remote/media_metadata.py?raw';
import videoUpscale from './colab-remote/video_upscale.py?raw';
import videoLora from './colab-remote/video_lora.py?raw';
import queueControl from './colab-remote/queue_control.py?raw';
import runner from './colab-remote/remote_job.py?raw';
import promptTranslation from './colab-remote/prompt_translation.py?raw';
import storage from './colab-remote/drive_storage.py?raw';
import workflow from './colab-remote/h3_tts32_api.json?raw';
import watchdog from './colab-remote/watchdog.py?raw';
export type Runtime={owner:string,nbh:string,gpu:string,phase:string,data:any,settings:any,updated_at:number};
const active=(s:Runtime|null)=>s&&!['stopped','error'].includes(s.phase);
const runtimeLimits=[0,30,60,90,120,180,240,300,360];
export async function getRuntime(user:string):Promise<Runtime|null>{const r=await db().prepare('SELECT * FROM songyin_colab_runtime WHERE owner=?').bind(user).first<any>();return r?{...r,data:await unseal(user,r.data),settings:JSON.parse(r.settings)}:null}
async function save(s:Runtime){await db().prepare('UPDATE songyin_colab_runtime SET phase=?,data=?,settings=?,updated_at=? WHERE owner=? AND nbh=?').bind(s.phase,await seal(s.owner,s.data),JSON.stringify(s.settings),now(),s.owner,s.nbh).run()}
export function validateSettings(s:any){
  if(!s||!['L4','G4','A100','H100'].includes(s.gpu)||!['drive-first','source-first'].includes(s.cache)||![0,5,15,30,60].includes(Number(s.idle)))throw new ControlError('GPU 或閒置設定不正確');
  const runtimeMinutes=Number(s.runtimeMinutes??0);
  if(!runtimeLimits.includes(runtimeMinutes))throw new ControlError('GPU 運行上限不正確');
  return {gpu:s.gpu,cache:s.cache,idle:Number(s.idle),runtimeMinutes,idlePolicyVersion:2,pictures:s.pictures===true,...(s.gpu==='A100'&&s.highMemory===true?{highMemory:true}:{})};
}
export function publicRuntime(s:Runtime|null){if(!s)return null;return {gpu:s.gpu,phase:s.phase,message:s.data.message||'',driveReady:!!s.data.driveReady,driveURL:s.phase==='awaiting_drive'?s.data.driveURL:null,stage:s.data.status?.stage,operation:s.data.operation,progress:s.data.status?.progress,jobProgress:Object.entries<any>(s.data.status?.jobs||{}).map(([id,j])=>({id,status:j.status,progress:j.progress,started:j.started})),batchStarted:s.data.batchStarted,log:s.data.status?.log||[],idleMinutes:s.settings.idle,assignedAt:s.data.assignedAt||null,releasedAt:s.data.releasedAt||(s.phase==='stopped'&&s.data.assignedAt?s.updated_at:null),checkedAt:now(),stopAt:runtimeDeadline(s)*1000||null,lastActivity:s.data.lastActivity,gpuName:s.data.gpuName,startedAt:s.data.createdAt,gpuMemoryMiB:s.data.gpuMemoryMiB,hostMemoryKiB:s.data.hostMemoryKiB,assignmentPaused:s.phase==='assigning'&&s.data.assignmentPaused===true,retryAt:s.phase==='assigning'?s.data.retryAt:undefined}}
function assignmentQuery(s:Runtime):Record<string,string>{
  return {nbh:s.nbh,variant:'GPU',accelerator:s.gpu,...(s.gpu==='A100'&&s.settings.highMemory?{shape:'hm'}:{})};
}
function runtimeDeadline(s:Runtime){
  const minutes=s.settings.runtimeMinutes;
  return minutes&&s.data.assignedAt?s.data.assignedAt/1000+minutes*60:0;
}
function runtimeControl(s:Runtime,settings:Record<string,unknown>){
  return {...settings,idle_minutes:s.settings.idle,runtime_deadline:runtimeDeadline(s)};
}
const allocationBackoff=[10000,20000,40000];
async function handleAllocationError(s:Runtime,e:unknown){
  const status=e instanceof ControlError?e.upstreamStatus:undefined;
  const timeout=(e instanceof DOMException||e instanceof Error)&&e.name==='TimeoutError';
  const temporary=timeout||(status!==undefined?[502,503,504].includes(status):e instanceof ControlError&&e.status===502);
  const failures=(s.data.allocationFailures||0)+1;
  const http=status?`（HTTP ${status}）`:'';
  const request=`${s.gpu} 配發`;
  let message=`${request}未完成${http}。 ${e instanceof ControlError?e.message:'Colab 連線暫時中斷。'}`;
  if(timeout)message=`等候 Colab 回覆 ${request}逾時。`;
  else if(status===400)message=`Colab 拒絕 ${request}${http}。請確認目前帳號可使用此 GPU 規格與配額。`;
  else if(status===412)message=`Colab 拒絕 ${request}${http}。Colab 可能已達執行階段或使用限制，也可能暫時沒有這款 GPU。`;
  else if(temporary&&status)message=`Colab 暫時無法確認 ${request}${http}。`;
  s.data.allocationFailures=failures;
  if(temporary&&failures<=allocationBackoff.length){
    s.data.retryAt=now()+allocationBackoff[failures-1];
    s.data.message=message+' 等待後會檢查同一筆申請。';
  }else{
    delete s.data.retryAt;
    s.data.assignmentPaused=true;
    s.data.message=message+' 可重新檢查這筆申請，或取消後另選 GPU。';
  }
  await save(s);
}
async function listAssignments(s:Runtime){
  const list=await colab(s.owner,'assignments');
  if(!Array.isArray(list.assignments))throw new ControlError('Colab 暫時無法確認執行階段。',502);
  return list.assignments;
}

function isAllocating(s:Runtime){
  return s.phase==='booting'&&now()-(s.data.assignedAt||s.data.createdAt)<25000;
}

async function markReleased(s:Runtime){
  const end=runtimeDeadline(s);
  const timeLimitReached=Boolean(end&&now()/1000>=end);
  s.data.message=timeLimitReached?'已達設定的 GPU 運行上限，Colab 已釋放執行階段。':s.phase==='awaiting_drive'
    ?'等待 Drive 授權的時間已到，Colab 已釋放 GPU。請重新啟動後接續授權。'
    :'Colab 執行階段已釋放。';
  if(timeLimitReached&&s.data.jobIds?.length){
    const result=JSON.stringify({error:'已達 GPU 運行上限，這項工作可重新送出。'});
    await db().batch(s.data.jobIds.map((id:string)=>db().prepare(
      "UPDATE songyin_jobs SET state='error',result=?,updated_at=? WHERE owner=? AND id=? AND state IN ('queued','running')"
    ).bind(result,now(),s.data.jobOwner||s.owner,id)));
  }
  s.phase='stopped';
  if(s.data.assignedAt)s.data.releasedAt ||= now();
  s.data.driveReady=false;
  delete s.data.proxy;
  delete s.data.driveURL;
  await save(s);
}

async function refreshProxy(s:Runtime){
  const assignments=await listAssignments(s);
  const assignment=assignments.find((a:any)=>a.endpoint===s.data.endpoint);
  if(assignment){s.data.proxy=assignment.runtimeProxyInfo;return true}
  // Colab may return a new assignment before it appears in the account list.
  if(isAllocating(s)&&s.data.proxy)return true;
  await markReleased(s);
  return false;
}

async function failAndStop(s:Runtime,message:string){s.data.message=message;try{if(s.data.endpoint)await release(s.owner,s.data.endpoint);s.phase='error';s.data.driveReady=false;delete s.data.proxy}catch{s.phase='stop_failed';s.data.message=message+'；自動釋放尚未確認，請按「停止並釋放 GPU」。'}await save(s)}
export async function withLock<T>(user:string,fn:(s:Runtime)=>Promise<T>){const lease=now()+240000;const claim=await db().prepare('UPDATE songyin_colab_runtime SET lease_until=? WHERE owner=? AND lease_until<?').bind(lease,user,now()).run();if(!claim.meta.changes)throw new ControlError('前一個 Colab 操作仍在處理，請稍候。',409);try{const s=await getRuntime(user);if(!s)throw new ControlError('請先啟動 GPU');return await fn(s)}finally{await db().prepare('UPDATE songyin_colab_runtime SET lease_until=0 WHERE owner=? AND lease_until=?').bind(user,lease).run()}}
export async function startRuntime(user:string,settings:any){const selected=validateSettings(settings);const current=await getRuntime(user);if(active(current))return {runtime:publicRuntime(current)};const usage=await colab(user,'ccu-info');if(typeof usage.currentBalance==='number'&&usage.currentBalance<5)throw new ControlError('Colab 剩餘運算單元不足 5 CU，請先補足額度。');const nbh=crypto.randomUUID().replace(/-/g,'_').padEnd(44,'.');const data=await seal(user,{createdAt:now(),lastActivity:now(),session:crypto.randomUUID(),message:'正在向 Colab 申請 '+selected.gpu+' GPU'});await db().prepare("INSERT INTO songyin_colab_runtime(owner,nbh,gpu,phase,data,settings,updated_at) VALUES(?,?,?,'assigning',?,?,?) ON CONFLICT(owner) DO UPDATE SET nbh=excluded.nbh,gpu=excluded.gpu,phase=excluded.phase,data=excluded.data,settings=excluded.settings,lease_until=0,updated_at=excluded.updated_at WHERE songyin_colab_runtime.phase IN ('stopped','error') AND songyin_colab_runtime.lease_until<?").bind(user,nbh,selected.gpu,data,JSON.stringify(selected),now(),now()).run();return {runtime:publicRuntime(await getRuntime(user))}}
const pyJSON=(v:unknown)=>'json.loads('+JSON.stringify(JSON.stringify(v))+')';
async function bootstrap(s:Runtime){const config=runtimeControl(s,{busy:true,deadline:now()/1000+600,started:now()/1000,last_activity:now()/1000});const result=await execute(s.data.proxy,s.data.kernel,s.data.session,`import os, json, time, subprocess, sys
from pathlib import Path
assert os.environ.get('TBE_RUNTIME_ADDR'), 'Colab 自動釋放介面不存在'
root=Path('/content/h3job'); root.mkdir(exist_ok=True); (root/'inputs').mkdir(exist_ok=True)
gpu,memory=subprocess.check_output(['nvidia-smi','--id=0','--query-gpu=name,memory.total','--format=csv,noheader,nounits'],text=True).strip().rsplit(',',1)
print('GPU_NAME='+gpu)
print('GPU_MEMORY_MIB='+str(int(memory.strip())))
host_ram=next(line for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemTotal:')).split()[1]
print('HOST_MEMORY_KIB='+host_ram)
selected=${JSON.stringify(s.gpu)}
assert (selected in gpu) or (selected=='G4' and ('RTX PRO 6000' in gpu or 'G4' in gpu)), '實際 GPU 與選擇不符'
(root/'watchdog.py').write_text(${JSON.stringify(watchdog)},encoding='utf-8')
if not (root/'control.json').exists(): (root/'control.json').write_text(json.dumps(${pyJSON(config)}))
subprocess.Popen([sys.executable,str(root/'watchdog.py')],stdin=subprocess.DEVNULL,stdout=open(root/'watchdog.log','a'),stderr=subprocess.STDOUT,start_new_session=True)
print('SONGYIN_GUARD_READY')`);
  if(!result.output.includes('SONGYIN_GUARD_READY'))throw new ControlError('無法確認閒置保護已啟動',502);
  s.data.gpuName=result.output.match(/GPU_NAME=([^\n]+)/)?.[1]||s.gpu;
  s.data.gpuMemoryMiB=Number(result.output.match(/GPU_MEMORY_MIB=(\d+)/)?.[1])||undefined;
  s.data.hostMemoryKiB=Number(result.output.match(/HOST_MEMORY_KIB=(\d+)/)?.[1])||undefined;
  s.phase='mounting';
  s.data.message='GPU 已連線，正在連接 Google Drive';
  await save(s);
}
function drivePropagation(s:Runtime,dry:boolean,token?:string){
  const path='credentials-propagation/'+encodeURIComponent(s.data.endpoint);
  const query={authtype:'dfs_ephemeral',version:'2',dryrun:dry?'true':'false',propagate:'true',record:'false'};
  if(!token)return colab(s.owner,path,'GET',query);
  const body=new FormData();
  body.set('file_id','empty.ipynb');
  return colab(s.owner,path,'POST',query,token,body);
}

function googleURL(url:string){
  try{
    const u=new URL(url);
    return u.protocol==='https:'&&!u.username&&!u.password&&['accounts.google.com','colab.research.google.com'].includes(u.hostname)?u.href:null;
  }catch{return null}
}

async function driveToken(s:Runtime):Promise<string>{
  if(typeof s.data.driveToken==='string'&&s.data.driveToken)return s.data.driveToken;
  const reply=await drivePropagation(s,true);
  if(typeof reply.token!=='string'||!reply.token)throw new ControlError('Colab 未回傳 Drive 授權資訊',502);
  s.data.driveToken=reply.token;
  return reply.token;
}

async function waitForDrive(s:Runtime,result:any){
  const url=s.data.driveURL||googleURL(result.unauthorized_redirect_uri);
  if(!url)throw new ControlError('Google 尚未提供 Drive 授權頁，請重新檢查。',502);
  s.phase='awaiting_drive';
  s.data.driveURL=url;
  s.data.message=s.data.driveChecked
    ?'Google 尚未把 Drive 存取權交給這次 Colab。請用同一 Google 帳號完成已開啟的授權頁，再回鳥巢H3大師重新確認。'
    :'請開啟 Google Drive 授權，完成後回來確認。';
  await save(s);
}

async function checkDriveConsent(s:Runtime,resume:boolean){
  let token=await driveToken(s);
  if(!resume){
    const preview=await drivePropagation(s,true,token);
    if(preview.success!==true){await waitForDrive(s,preview);return false}
  }

  // The preview can still report unauthorised after the user accepted its link.
  // Resume must perform the actual propagation using that attempt's token.
  s.data.driveChecked=resume;
  let result;
  try{
    result=await drivePropagation(s,false,token);
  }catch(e){
    if(!(e instanceof ControlError)||![400,403,412].includes(e.upstreamStatus??0))throw e;
    delete s.data.driveToken;
    token=await driveToken(s);
    result=await drivePropagation(s,false,token);
  }
  if(result.success===false||result.unauthorized_redirect_uri){
    await waitForDrive(s,result);
    return false;
  }
  return true;
}

const mountCode=`import os, json, time
from pathlib import Path
from google.colab import drive
if not os.path.ismount('/content/drive'): drive.mount('/content/drive', timeout_ms=45000)
assert os.path.ismount('/content/drive'), 'Google Drive 未掛載'
root=Path('/content/drive/MyDrive/Colab H3')
root.mkdir(parents=True,exist_ok=True)
probe=root/'.songyin-write-check'; probe.write_text('ok'); probe.unlink()
Path('/content/h3job/drive_ready.json').write_text(json.dumps({'ready':True,'time':time.time()}))
print('SONGYIN_DRIVE_READY')`;
const driveMarker='content/h3job/drive_ready.json';

async function markDriveReady(s:Runtime){
  await writeFile(s.data.proxy,'content/h3job/control.json',JSON.stringify(runtimeControl(s,{busy:false,last_activity:now()/1000})));
  s.phase='ready';
  s.data.driveReady=true;
  s.data.message='GPU 與 Google Drive 已接通，可以送出工作。';
  s.data.lastActivity=now();
  delete s.data.driveRequest;
  delete s.data.driveURL;
  delete s.data.driveToken;
  delete s.data.driveChecked;
  await save(s);
}

async function createKernel(s:Runtime){
  const kernel=await remote(s.data.proxy,'api/kernels','POST',{name:'python3'});
  if(!kernel?.id)throw new ControlError('Colab kernel 尚未就緒',502);
  s.data.kernel=kernel.id;
  s.data.session=crypto.randomUUID();
  await save(s);
}

async function mountDrive(s:Runtime,resume:boolean){
  if((await readJSON(s.data.proxy,driveMarker))?.ready===true){await markDriveReady(s);return}
  if(!await checkDriveConsent(s,resume||Boolean(s.data.mountStartedAt)))return;
  const previousMountPending=Boolean(s.data.driveRequest||s.data.mountStartedAt);
  s.phase='mounting';
  s.data.message='Drive 已授權，正在驗證掛載與寫入。';
  delete s.data.driveURL;
  delete s.data.driveRequest;
  s.data.mountStartedAt=now();
  await save(s);
  if(previousMountPending)await createKernel(s);
  // The credentials are already in this VM. Acknowledge the mount request
  // on the same socket as the kernel execution.
  await execute(s.data.proxy,s.data.kernel,s.data.session,mountCode,{
    timeout:60000,
    onDrive:async()=>true
  });
  if((await readJSON(s.data.proxy,driveMarker))?.ready!==true)throw new ControlError('尚未確認 Drive 可以寫入',502);
  await markDriveReady(s);
}

export async function advanceRuntime(user:string,resume=false,recheckAssignment=false){
  return withLock(user,async s=>{
    const step=s.phase;
    try{
      if(step==='assigning'){
        if(!recheckAssignment&&(s.data.assignmentPaused||now()<(s.data.retryAt||0)))return {runtime:publicRuntime(s)};
        if(recheckAssignment){
          delete s.data.assignmentPaused;
          delete s.data.retryAt;
          s.data.allocationFailures=0;
        }
        const query=assignmentQuery(s);
        let assigned=await colab(user,'assign','GET',query,undefined,undefined,45000);
        if(!assigned.endpoint&&assigned.token)assigned=await colab(user,'assign','POST',query,assigned.token,undefined,75000);
        if(!assigned.endpoint||!assigned.runtimeProxyInfo)throw new ControlError('Colab 尚未回傳 GPU 分配結果。',502);
        s.data.endpoint=assigned.endpoint;
        s.data.proxy=assigned.runtimeProxyInfo;
        if(assigned.accelerator&&assigned.accelerator!==s.gpu){
          await failAndStop(s,'Colab 配發的 GPU 不符合選擇，已要求釋放。');
          return {runtime:publicRuntime(s)};
        }
        s.phase='booting';
        s.data.assignedAt=now();
        s.data.message='Colab 已分配 GPU，正在等候環境就緒。';
        await save(s);
        return {runtime:publicRuntime(s)};
      }
      if(!['booting','mounting','awaiting_drive'].includes(step)||step==='awaiting_drive'&&!resume)return {runtime:publicRuntime(s)};
      if(!await refreshProxy(s))return {runtime:publicRuntime(s)};
      if(step==='booting'){
        if(!s.data.kernel)await createKernel(s);
        await bootstrap(s);
      }else{
        await mountDrive(s,resume);
      }
      return {runtime:publicRuntime(s)};
    }catch(e){
      const message=e instanceof ControlError?e.message:'Colab 連線逾時或暫時中斷。';
      console.warn('songyin colab advance',{phase:step,reason:e instanceof Error||e instanceof DOMException?e.name:'UnknownError',status:e instanceof ControlError?e.status:503,upstreamStatus:e instanceof ControlError?e.upstreamStatus:undefined,gpu:s.gpu});
      if(step==='assigning'){
        if(e instanceof ControlError&&e.status===401)throw e;
        await handleAllocationError(s,e);
        return {runtime:publicRuntime(s)};
      }
      if(step==='booting'&&now()-(s.data.assignedAt||s.data.createdAt)<180000&&!(e instanceof ControlError&&e.status<500)){
        s.data.message='Colab GPU 正在啟動，將自動重試。';
        await save(s);
        return {runtime:publicRuntime(s)};
      }
      if(['mounting','awaiting_drive'].includes(step)&&!s.data.mountRetried&&now()-(s.data.assignedAt||s.data.createdAt)<480000){
        s.data.mountRetried=true;
        if(s.phase!=='awaiting_drive'||s.data.mountStartedAt){
          s.phase='mounting';
          s.data.message='Drive 首次掛載中斷，將在同一個 GPU 執行階段重試。';
        }else{
          s.data.message='尚未確認 Drive 授權，請稍候再按確認。';
        }
        await save(s);
        return {runtime:publicRuntime(s)};
      }
      await failAndStop(s,message);
      return {runtime:publicRuntime(s)};
    }
  });
}
export async function stopRuntime(user:string){
  return withLock(user,async s=>{
    if(s.phase==='assigning'&&!s.data.endpoint){
      const a=await colab(user,'assign','GET',assignmentQuery(s),undefined,undefined,45000);
      if(a.endpoint){
        s.data.endpoint=a.endpoint;
        await save(s);
      }
    }
    if(s.data.endpoint){
      await release(user,s.data.endpoint);
      const assignments=await listAssignments(s);
      if(assignments.some((a:any)=>a.endpoint===s.data.endpoint)){
        s.phase='stop_failed';
        s.data.message='已要求釋放，Colab 尚未確認，請再次檢查。';
        await save(s);
        return {runtime:publicRuntime(s)};
      }
    }
    s.phase='stopped';
    if(s.data.assignedAt)s.data.releasedAt ||= now();
    s.data.driveReady=false;
    s.data.message=s.data.endpoint?'GPU 已停止並釋放。':'已取消這筆 GPU 申請。';
    delete s.data.proxy;
    await save(s);
    return {runtime:publicRuntime(s)};
  });
}
function usesOldIdleDefault(s:Runtime){
  return s.settings.idle===5&&!s.settings.idlePolicyVersion&&['ready','running'].includes(s.phase);
}

async function migrateRuntimeIdle(s:Runtime,assignment:any){
  const proxy=assignment.runtimeProxyInfo;
  if(!proxy)return;
  const controlPath='content/h3job/control.json';
  try{
    const control=await readJSON(proxy,controlPath);
    if(!control)return;
    await writeFile(proxy,controlPath,JSON.stringify({...control,idle_minutes:15}));
  }catch{
    // If Colab is momentarily busy, keep its current settings and retry on the next poll.
    return;
  }
  s.settings.idle=15;
  s.settings.idlePolicyVersion=2;
  await save(s);
}

export async function controllerStatus(user:string){
 const a=await authRow(user);let s=await getRuntime(user);
 if(!a?.credentials)return {configured:configured(),connected:false,runtime:publicRuntime(s)};
 const usage=await colab(user,'ccu-info');
 if(s?.data.endpoint&&active(s)){
  const endpoint=s.data.endpoint;
  const assignment=(await listAssignments(s)).find((item:any)=>item.endpoint===endpoint);
  const disappeared=!assignment&&!isAllocating(s);
  // Only take the operation lease for polling a run or writing a state change.
  try{if(disappeared||s.phase==='running'||assignment&&usesOldIdleDefault(s))s=await withLock(user,async current=>{
   if(current.data.endpoint!==endpoint||!active(current))return current;
   if(!disappeared&&assignment&&usesOldIdleDefault(current))await migrateRuntimeIdle(current,assignment);
   if(disappeared){
    await markReleased(current);
   }else if(current.phase==='running'&&assignment){
     current.data.proxy=assignment.runtimeProxyInfo;
     const st=await readJSON(current.data.proxy,'content/h3job/status.json');
     if(st&&st.started>=current.data.batchStarted/1000-5&&(!current.data.queueBatchId||st.queue_id===current.data.queueBatchId)){
      const jobOwner=current.data.jobOwner||user;
      current.data.status=st;
      const updates=[];
      let archivedThisPoll=false;
      let hasPendingArchive=false;
      const failures=current.data.archiveFailures ||= {};
      const seen=new Set<string>();
      for(const [id,result]of Object.entries<any>(st.jobs||{})){
       if(!current.data.jobIds?.includes(id))continue;
       seen.add(id);
       let state=['done','error','running','queued','cancelled'].includes(result.status)?result.status:'running';
       let saved={...result,driveFolder:st.drive_folder||null};
       if(state==='done'){
        const previous=await db().prepare('SELECT result FROM songyin_jobs WHERE owner=? AND id=?').bind(jobOwner,id).first<{result:string|null}>();
        const old=previous?.result?JSON.parse(previous.result):null;
        if(old?.archived)saved=old;
        else if(failures[id])saved.archiveError=failures[id];
        else if(!archivedThisPoll){
          // Finish one transfer at a time. A large result is streamed to R2.
          archivedThisPoll=true;
          try{saved=await archiveResult(current.data.proxy,jobOwner,id,saved)}
          catch{
            saved.archiveError=failures[id]='作品已備份，站內收錄暫未完成，可從儲存區重新收錄。';
          }
        }else hasPendingArchive=true;
       }
       if(st.done&&['running','queued'].includes(state)){
        state='error';
        saved.error=st.error||'批次提前結束，這項工作可重新送出。';
       }
       updates.push(db().prepare("UPDATE songyin_jobs SET state=?,result=?,updated_at=? WHERE owner=? AND id=? AND state<>'cancelled'").bind(state,JSON.stringify(saved),now(),jobOwner,id));
      }
      if(st.done)for(const id of (current.data.jobIds||[])){
       if(seen.has(id))continue;
       updates.push(db().prepare("UPDATE songyin_jobs SET state='error',result=?,updated_at=? WHERE owner=? AND id=? AND state<>'cancelled'").bind(JSON.stringify({error:st.error||'批次提前結束，這項工作可重新送出。'}),now(),jobOwner,id));
      }
      if(updates.length)await db().batch(updates);
      if(st.done&&hasPendingArchive){
       current.data.status={...st,stage:'archiving'};
       current.data.message='生成已完成，正在收錄其餘作品。';
      }else if(st.done){
       current.phase='ready';current.data.lastActivity=now();
       current.data.message=st.error||Object.values<any>(st.jobs||{}).some(j=>j.status==='error')
         ?'有工作未完成，請查看紀錄。'
         :Object.keys(failures).length?'生成完成，部分作品可在儲存區重新收錄。':'這批工作已完成，可在儲存區播放。';
      }
     }
     await save(current);
   }
   return current;
  })}catch(e){if(!(e instanceof ControlError&&e.status===409))throw e;s=await getRuntime(user)}
 }
 return {configured:configured(),connected:true,email:a.email,balance:usage.currentBalance,rate:usage.consumptionRateHourly,runtime:publicRuntime(s)};
}
export async function activity(user:string){return withLock(user,async s=>{if(!['ready','running'].includes(s.phase))return {ok:true};if(now()-(s.data.lastActivity||0)<20000)return {ok:true};if(!await refreshProxy(s))return {ok:true};const c=await readJSON(s.data.proxy,'content/h3job/control.json');if(c){c.last_activity=now()/1000;await writeFile(s.data.proxy,'content/h3job/control.json',JSON.stringify(c));s.data.lastActivity=now();await save(s)}return {ok:true}})}

async function queuedRows(runtime:Runtime|null){
  const ids:string[]=runtime?.phase==='running'?runtime.data.jobIds||[]:[];
  if(!runtime||!ids.length)return [];
  const rows=await db().prepare(`SELECT id,kind,prompt,manifest FROM songyin_jobs WHERE owner=? AND state='queued' AND id IN (${ids.map(()=>'?').join(',')})`)
    .bind(runtime.data.jobOwner||runtime.owner,...ids)
    .all<{id:string;kind:string;prompt:string;manifest:string}>();
  const byId=new Map(rows.results.map(row=>[row.id,row]));
  return ids.flatMap(id=>byId.has(id)?[byId.get(id)!]:[]);
}

export async function generationQueue(user:string){
  const runtime=await getRuntime(user);
  const rows=await queuedRows(runtime);
  let states=runtime?.data.status?.jobs;
  if(rows.length&&runtime?.data.proxy){
    try{
      const live=await readJSON(runtime.data.proxy,'content/h3job/status.json');
      if(live?.started>=runtime.data.batchStarted/1000-5&&(!runtime.data.queueBatchId||live.queue_id===runtime.data.queueBatchId)){
        states=live.done?Object.fromEntries(rows.map(row=>[row.id,{status:'done'}])):live.jobs;
      }
    }catch{ /* A queue snapshot remains available if the runtime is momentarily unreachable. */ }
  }
  return {
    batchId:runtime?.data.queueBatchId||null,
    cancellable:Boolean(runtime?.data.queueBatchId),
    items:rows.filter(row=>!states?.[row.id]||states[row.id].status==='queued').map(row=>{
      const manifest=JSON.parse(row.manifest);
      return {id:row.id,kind:row.kind,prompt:traditionalPrompt(row.prompt,row.kind).slice(0,180),seconds:manifest.seconds,operation:manifest.operation};
    }),
  };
}

export async function removeQueuedGeneration(user:string,request:{id?:unknown;all?:unknown;batchId?:unknown}){
  const {id,all,batchId}=request;
  if(all!==true&&(typeof id!=='string'||!jobIdPattern.test(id)))throw new ControlError('找不到排隊項目。',400);
  return withLock(user,async runtime=>{
    const rows=await queuedRows(runtime);
    const targets=rows.filter(row=>all===true||row.id===id).map(row=>row.id);
    if(!targets.length)return {removed:0,skipped:all===true?0:1};
    const batch=runtime.data.queueBatchId;
    if(!batch)throw new ControlError('此批次啟動於更新前，請等待這批工作完成。',409);
    if(batchId!==batch)throw new ControlError('排隊批次已變更，請檢查更新後的清單。',409);
    if(!await refreshProxy(runtime))throw new ControlError('排隊批次已結束，請重新整理。',409);
    const reply=await execute(runtime.data.proxy,runtime.data.kernel,runtime.data.session,`import sys, json
from pathlib import Path
root=Path('/content/h3job')
sys.path.insert(0,str(root))
from queue_control import cancel_pending
print('SONGYIN_QUEUE='+json.dumps(cancel_pending(root,${JSON.stringify(batch)},${JSON.stringify(targets)})))`);
    const line=reply.output.split('\n').find(part=>part.startsWith('SONGYIN_QUEUE='));
    if(!line)throw new ControlError('目前無法確認刪除結果，請重新整理排隊清單。',502);
    const answer=JSON.parse(line.slice('SONGYIN_QUEUE='.length));
    const removed=targets.filter(jobId=>Array.isArray(answer.removed)&&answer.removed.includes(jobId));
    if(removed.length){
      await db().batch(removed.map(jobId=>db().prepare("UPDATE songyin_jobs SET state='cancelled',result=NULL,updated_at=? WHERE owner=? AND id=? AND state='queued'")
        .bind(now(),runtime.data.jobOwner||user,jobId)));
    }
    return {removed:removed.length,skipped:targets.length-removed.length};
  });
}

function fileName(f:any){const ext=f.name.match(/\.([a-zA-Z0-9]{1,8})$/)?.[1];return f.id+(ext?'.'+ext:'')}
export function manifestJob(j:any){
  if(j.operation==='upscale'){
    return {id:j.id,type:'video',operation:'upscale',source:j.source,upscale:j.upscale,seconds:j.seconds};
  }
  const files=j.files.map(fileName);
  const out={...j,files:undefined};
  if(j.type==='tts'){
    out.voices=files;
    if(j.prompt)out.prompt=normalizeReferences(j.prompt,'model');
  }else if(j.type==='video'&&j.mode==='frames'){
    out.first=files[0];
    if(files[1])out.last=files[1];
    if(j.prompt)out.prompt=submissionPrompt(j.type,j.mode,j.prompt);
  }else if(j.type==='video'&&j.mode==='text'){
    if(j.prompt)out.prompt=submissionPrompt(j.type,j.mode,j.prompt);
  }else{
    out.inputs=files;
    if(j.prompt&&(j.type==='image'||j.type==='video'&&j.mode==='ref'))out.prompt=normalizeReferences(j.prompt);
  }
  if(out.prompt)Object.assign(out,planModelPrompt(out.prompt,j.type));
  return out;
}
export async function importResult(user:string,id:unknown){
  if(typeof id!=='string'||!jobIdPattern.test(id))throw new ControlError('找不到作品',404);
  return withLock(user,async runtime=>{
    if(runtime.phase!=='ready'||!runtime.data.driveReady||!await refreshProxy(runtime)){
      throw new ControlError('請先啟動 GPU 並接通 Drive，再收錄舊作品。',409);
    }
    const row=await db().prepare("SELECT result,kind,manifest FROM songyin_jobs WHERE owner=? AND id=? AND state='done'")
      .bind(user,id).first<{result:string|null,kind:string,manifest:string}>();
    if(!row?.result)throw new ControlError('找不到作品',404);
    const result=JSON.parse(row.result);
    if(result.archived)return {result};
    const folder=result.driveFolder;
    if(!lawfulFile(id,result.file)||typeof folder!=='string'||!/^\/content\/drive\/MyDrive\/Colab H3\/生成作品\/[a-zA-Z0-9_-]+$/.test(folder)){
      throw new ControlError('這筆舊紀錄沒有可收錄的 Drive 檔案位置。',400);
    }
    const temporary='content/h3job/archive/'+id;
    await writeFile(runtime.data.proxy,'content/h3job/media_metadata.py',mediaMetadata);
    const parameters={source:folder+'/'+result.file,folder:'/'+temporary,id,kind:row.kind};
    const execution=await execute(runtime.data.proxy,runtime.data.kernel,runtime.data.session,`import json, shutil, sys
from pathlib import Path
sys.path.insert(0,'/content/h3job')
from media_metadata import probe, poster_for, prepare_video
data=${pyJSON(parameters)}
src=Path(data['source'])
assert src.is_file(), '找不到原始 Drive 作品'
out=Path(data['folder']); out.mkdir(parents=True,exist_ok=True)
if data['kind']=='video':
 dst=out/(data['id']+'.mp4')
 media=prepare_video(src,dst,0,check_duration=False)
else:
 dst=out/src.name
 shutil.copyfile(src,dst)
 media=probe(dst)
 if data['kind']=='image': media.update(duration=None,fps=None)
poster={}
if data['kind'] in ('video','image'):
 try: poster=poster_for(dst,out/(data['id']+'-poster.jpg'))
 except Exception: pass
print('SONGYIN_MEDIA='+json.dumps(dict(file=dst.name,bytes=dst.stat().st_size,media=media,**poster)))`,{timeout:90000});
    const line=execution.output.split('\n').find(text=>text.startsWith('SONGYIN_MEDIA='));
    if(!line)throw new ControlError('未能讀取舊作品規格。',502);
    const measured=JSON.parse(line.slice('SONGYIN_MEDIA='.length));
    const archived=await archiveResult(runtime.data.proxy,user,id,{
      ...result,...measured,requested_seconds:result.requested_seconds??JSON.parse(row.manifest).seconds
    },temporary);
    await db().prepare('UPDATE songyin_jobs SET result=? WHERE owner=? AND id=?').bind(JSON.stringify(archived),user,id).run();
    runtime.data.lastActivity=now();
    await writeFile(runtime.data.proxy,'content/h3job/control.json',JSON.stringify(runtimeControl(runtime,{busy:false,last_activity:now()/1000})));
    await save(runtime);
    return {result:archived};
  });
}

type UploadFile={key:string;name:string;bytes:number};

export async function runJobs(user:string,ids:unknown,confirmed:unknown,expected?:Record<string,number>,jobOwner=user,creatorVideo=false){
  if(!Array.isArray(ids)||!ids.length||ids.length>20||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length){
    throw new ControlError('一次請選擇 1–20 項工作');
  }
  return withLock(user,async runtime=>{
    if(runtime.phase!=='ready'||!runtime.data.driveReady)throw new ControlError('請先接通 GPU 與 Google Drive');
    if(!await refreshProxy(runtime))throw new ControlError('GPU 已釋放，請重新啟動');
    const jobs=[];
    for(const id of ids){
      const row=await db().prepare("SELECT manifest FROM songyin_jobs WHERE owner=? AND id=? AND state IN ('draft','error')")
        .bind(jobOwner,id).first<{manifest:string}>();
      if(!row)throw new ControlError('有工作已送出或不存在，請重新整理');
      const original=JSON.parse(row.manifest);
      if(original.operation==='upscale')throw new ControlError('請由原作品的播放器送出放大。');
      if(creatorVideo&&original.lora)throw new ControlError('這項 LoRA 工作請從管理員介面送出。',409);
      const locked=creatorVideo&&original.type==='video';
      const saved=locked?applyCreatorVideoSettings(original):original;
      const problem=checkReferences(saved.type,saved.mode,saved.prompt,saved.files);
      if(problem)throw new ControlError(problem);
      if(expected&&!locked&&saved.type!=='image'&&saved.seconds!==expected[id]){
        throw new ControlError('佇列秒數已變更，請重新整理後確認再送出。',409);
      }
      jobs.push(saved);
    }
    if(jobs.filter(job=>job.type==='video').length>=2&&confirmed!==true)throw new ControlError('請先確認這批影片的秒數、比例與解析度');
    const assets=jobs.flatMap(job=>job.files.map((file:any)=>({key:jobOwner+'/'+file.id,name:fileName(file),bytes:file.bytes})));
    return dispatchJobs(runtime,jobOwner,jobs,assets);
  });
}

function atVideoLimit(media:any){
  const {width,height}=media||{};
  return width>0&&height>0&&(height>width?width>=2160||height>=3840:width>=3840||height>=2160);
}

export async function runSavedUpscale(runtimeOwner:string,identity:Identity,sourceId:string,request:{factor:unknown;confirmed:unknown;requestId:unknown}){
  const {factor,confirmed,requestId}=request;
  if(!jobIdPattern.test(sourceId))throw new ControlError('找不到可放大的影片。',404);
  if(confirmed!==true||!isVideoUpscaleFactor(factor)||identity.role==='creator'&&factor!==creatorVideoSettings.upscale){
    throw new ControlError('請確認可使用的影片放大倍率。');
  }
  if(typeof requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)){
    throw new ControlError('送出資料不正確。');
  }
  const id='job_upscale_'+requestId.toLowerCase();
  const owner=identity.id;
  const prior=await db().prepare('SELECT state,manifest FROM songyin_jobs WHERE id=? AND owner=?')
    .bind(id,owner).first<{state:string;manifest:string}>();
  if(prior){
    const job=JSON.parse(prior.manifest);
    if(job.operation!=='upscale'||job.sourceId!==sourceId||job.upscale!==factor||prior.state==='error'){
      throw new ControlError('這筆放大工作已結束，請重新確認後送出。',409);
    }
    return {id};
  }
  return withLock(runtimeOwner,async runtime=>{
    const row=await db().prepare("SELECT prompt,manifest,result FROM songyin_jobs WHERE id=? AND owner=? AND kind='video' AND state='done'")
      .bind(sourceId,owner).first<{prompt:string;manifest:string;result:string|null}>();
    const result=row?.result?JSON.parse(row.result):null;
    const ext=String(result?.file??'').split('.').at(-1)||'';
    if(!row||!result?.archived||!lawfulFile(sourceId,result.file)||!types[ext]?.startsWith('video/')){
      throw new ControlError('找不到可放大的影片。',404);
    }
    if(atVideoLimit(result.media))throw new ControlError('這支影片已達 4K 出片上限。',409);
    if(runtime.phase!=='ready'||!runtime.data.driveReady||!await refreshProxy(runtime)){
      throw new ControlError('創作服務尚未就緒，或正在執行其他工作。',409);
    }
    const key=mediaKey(owner,sourceId,false);
    const object=await env.BUCKET!.head(key);
    if(!object?.size||object.size!==result.bytes){
      throw new ControlError('站內沒有完整影片，請先收錄原檔。',409);
    }
    const source=id+'_source.'+ext;
    const previous=JSON.parse(row.manifest);
    const job={id,type:'video',operation:'upscale',sourceId,source,upscale:factor,prompt:row.prompt,
      files:previous.files||[],seconds:result.media?.duration??previous.seconds};
    const stamp=now();
    await db().prepare("INSERT INTO songyin_jobs(id,owner,kind,prompt,manifest,state,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)")
      .bind(id,owner,'video',row.prompt,JSON.stringify(job),stamp,stamp).run();
    try{
      await dispatchJobs(runtime,owner,[job],[{key,name:source,bytes:object.size}]);
      return {id};
    }catch(error){
      const state=JSON.stringify({error:'放大工作未能送出，可在原作品重新送出。'});
      await db().prepare("UPDATE songyin_jobs SET state='error',result=?,updated_at=? WHERE owner=? AND id=? AND state='queued'")
        .bind(state,now(),owner,id).run();
      throw error;
    }
  });
}

async function dispatchJobs(s:Runtime,jobOwner:string,jobs:any[],assets:UploadFile[]){
  const previousState={...s.data};
  const ids=jobs.map(job=>job.id);
  const totalBytes=assets.reduce((total,file)=>total+file.bytes,0);
  let sentBytes=0;
  s.data.batchStarted=now();s.data.jobIds=ids;s.data.jobOwner=jobOwner;s.data.archiveFailures={};s.data.lastActivity=now();
  s.data.operation=jobs.every(job=>job.operation==='upscale')?'upscale':undefined;
  s.data.queueBatchId=crypto.randomUUID();
  s.data.status={stage:'uploading',progress:{stage:'uploading',completed:0,total:totalBytes,unit:'bytes'},log:['正在傳送工作與素材至 Colab']};
  s.phase='uploading';
  await save(s);
  try{
    await writeFile(s.data.proxy,'content/h3job/control.json',JSON.stringify(runtimeControl(s,{busy:true,started:now()/1000,deadline:runtimeDeadline(s)||now()/1000+7200,last_activity:now()/1000})));
    for(const [name,content] of Object.entries({'remote_job.py':runner,'drive_storage.py':storage,'h3_tts32_api.json':workflow,'media_metadata.py':mediaMetadata,'video_upscale.py':videoUpscale,'video_lora.py':videoLora,'queue_control.py':queueControl,'prompt_translation.py':promptTranslation})){
      await writeFile(s.data.proxy,'content/h3job/'+name,content);
    }
    for(const file of assets){
      const head=await env.BUCKET!.head(file.key);
      if(!head||head.size!==file.bytes)throw new ControlError('工作素材不完整，請重新同步');
      for(let offset=0,index=1;offset<file.bytes;index++){
        const length=Math.min(2*1024*1024,file.bytes-offset);
        const obj=await env.BUCKET!.get(file.key,{range:{offset,length}});
        if(!obj)throw new ControlError('找不到素材');
        const chunk=file.bytes<=length?undefined:offset===0?1:offset+length>=file.bytes?-1:index;
        await writeFile(s.data.proxy,'content/h3job/inputs/'+file.name,new Uint8Array(await obj.arrayBuffer()),chunk);
        offset+=length;sentBytes+=length;s.data.status.progress.completed=sentBytes;
        await save(s);
      }
    }
    const manifest={jobs:jobs.map(manifestJob),queue_id:s.data.queueBatchId,drive_root:'/content/drive/MyDrive/Colab H3',model_source:s.settings.cache,install_pictures:s.settings.pictures,gpu:s.gpu,stop_on_error:true};
    await writeFile(s.data.proxy,'content/h3job/manifest.json',JSON.stringify(manifest));
    const result=await execute(s.data.proxy,s.data.kernel,s.data.session,`import os, subprocess, sys, json, time
from pathlib import Path
root=Path('/content/h3job')
pidfile=root/'runner.pid'
alive=False
if pidfile.exists():
 try:
  pid=int(pidfile.read_text()); alive=('remote_job.py' in Path('/proc/'+str(pid)+'/cmdline').read_text())
 except (OSError,ValueError): pass
if alive:
 for _ in range(20):
  time.sleep(0.25)
  try:
   alive='remote_job.py' in Path('/proc/'+str(pid)+'/cmdline').read_text()
  except (OSError,ValueError):
   alive=False
  if not alive: break
if alive:
 print('SONGYIN_PREVIOUS_FINISHING')
else:
 sys.path.insert(0,str(root))
 from queue_control import initialize
 (root/'status.json').unlink(missing_ok=True)
 initialize(root,${JSON.stringify(s.data.queueBatchId)},${JSON.stringify(ids)})
 p=subprocess.Popen([sys.executable,str(root/'remote_job.py')],stdin=subprocess.DEVNULL,stdout=open(root/'remote_job.log','w'),stderr=subprocess.STDOUT,start_new_session=True,cwd=str(root))
 pidfile.write_text(str(p.pid))
 print('SONGYIN_JOB_STARTED')`);
    if(result.output.includes('SONGYIN_PREVIOUS_FINISHING')){
      s.phase='ready';
      s.data=previousState;
      await writeFile(s.data.proxy,'content/h3job/control.json',JSON.stringify(runtimeControl(s,{busy:false,last_activity:now()/1000})));
      await save(s);
      throw new ControlError('前一批工作仍在收尾，請稍後再試。',409);
    }
    if(!result.output.includes('SONGYIN_JOB_STARTED'))throw new ControlError('尚未確認工作啟動');
    s.phase='running';
    s.data.status={stage:'starting',log:['工作已送達 Colab']};
    s.data.message='工作已交給 Colab 執行，進度會自動更新。';
    await db().batch(jobs.map(job=>db().prepare("UPDATE songyin_jobs SET state='queued',manifest=?,result=NULL,updated_at=? WHERE owner=? AND id=?")
      .bind(JSON.stringify(job),now(),jobOwner,job.id)));
    await save(s);
    return {runtime:publicRuntime(s)};
  }catch(error){
    if(s.phase!=='ready')await failAndStop(s,'工作傳送失敗，GPU 已要求釋放；可重新啟動後重試。');
    throw error;
  }
}
