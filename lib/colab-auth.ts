import {env} from 'cloudflare:workers';
const administratorEmail=()=>env.ADMIN_GOOGLE_EMAIL?.trim().toLowerCase();
export class ControlError extends Error { constructor(message:string,public status=400,public upstreamStatus?:number){super(message)} }
export const db=()=>env.DB!;
export const now=()=>Date.now();
export const b64=(bytes:Uint8Array)=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s)};
export const unb64=(value:string)=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
const url64=(value:Uint8Array)=>b64(value).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
async function key(){if(!env.COLAB_ENCRYPTION_KEY)throw new ControlError('Colab 連線設定尚未完成',503);return crypto.subtle.importKey('raw',unb64(env.COLAB_ENCRYPTION_KEY),'AES-GCM',false,['encrypt','decrypt'])}
export async function seal(user:string,value:unknown){const iv=crypto.getRandomValues(new Uint8Array(12));const body=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(user)},await key(),new TextEncoder().encode(JSON.stringify(value)));return b64(iv)+'.'+b64(new Uint8Array(body))}
export async function unseal(user:string,value:string){const [iv,body]=value.split('.');return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv),additionalData:new TextEncoder().encode(user)},await key(),unb64(body))))}
export function oauthConfig(){if(!env.COLAB_OAUTH_CONFIG)throw new ControlError('Google 授權設定尚未完成',503);const c=JSON.parse(env.COLAB_OAUTH_CONFIG);return c.installed||c.web||c}
export const configured=()=>Boolean(env.COLAB_OAUTH_CONFIG&&env.COLAB_ENCRYPTION_KEY&&administratorEmail());
const redirect='https://sdk.cloud.google.com/applicationdefaultauthcode.html';
const scopes=['openid','https://www.googleapis.com/auth/userinfo.profile','https://www.googleapis.com/auth/userinfo.email','https://www.googleapis.com/auth/cloud-platform','https://www.googleapis.com/auth/colaboratory','https://www.googleapis.com/auth/drive.file'];
export async function authRow(user:string){return db().prepare('SELECT * FROM songyin_colab_auth WHERE owner=?').bind(user).first<any>()}
export async function isAdministrator(user:string){
  const email=administratorEmail();
  if(!email)return false;
  const auth=await authRow(user);
  return Boolean(auth?.credentials&&auth.email?.toLowerCase()===email);
}
export async function sharedRuntimeOwner(){
  const email=administratorEmail();
  if(!email)return null;
  const row=await db().prepare(
    "SELECT a.owner FROM songyin_colab_auth a JOIN songyin_colab_runtime r ON r.owner=a.owner WHERE LOWER(a.email)=? AND a.credentials IS NOT NULL ORDER BY CASE WHEN r.phase IN ('ready','uploading','running') THEN 0 ELSE 1 END,r.updated_at DESC LIMIT 1"
  ).bind(email).first<{owner:string}>();
  return row?.owner||null;
}
async function tokenRequest(values:Record<string,string>){const c=oauthConfig();const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:c.client_id,client_secret:c.client_secret,...values}),signal:AbortSignal.timeout(20000)});const t:any=await r.json();if(!r.ok)throw new ControlError(t.error==='invalid_grant'?'Google 授權已失效或授權碼已使用，請重新連接。':'Google 授權暫時無法完成，請重試。',401);return t}
export async function accessToken(user:string){const row=await authRow(user);if(!row?.credentials)throw new ControlError('請先連接 Google 帳號',401);let t=await unseal(user,row.credentials);if(t.expires_at<now()+60000){if(!t.refresh_token)throw new ControlError('Google 授權已到期，請重新連接。',401);const fresh=await tokenRequest({grant_type:'refresh_token',refresh_token:t.refresh_token});t={...t,...fresh,expires_at:now()+fresh.expires_in*1000};await db().prepare('UPDATE songyin_colab_auth SET credentials=?,updated_at=? WHERE owner=?').bind(await seal(user,t),now(),user).run()}return t.access_token as string}
export async function beginAuth(user:string){if(!configured())throw new ControlError('管理員或 Colab 授權設定尚未完成',503);const verifier=url64(crypto.getRandomValues(new Uint8Array(48)));const state=url64(crypto.getRandomValues(new Uint8Array(24)));const challenge=url64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));const pending=await seal(user,{verifier,state,expires:now()+10*60*1000});await db().prepare('INSERT INTO songyin_colab_auth(owner,pending,updated_at) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET pending=excluded.pending,updated_at=excluded.updated_at').bind(user,pending,now()).run();const c=oauthConfig();const q=new URLSearchParams({client_id:c.client_id,redirect_uri:redirect,response_type:'code',scope:scopes.join(' '),access_type:'offline',prompt:'consent',token_usage:'remote',state,code_challenge:challenge,code_challenge_method:'S256'});return {url:'https://accounts.google.com/o/oauth2/auth?'+q.toString(),expiresIn:600}}
function authorizationCode(value:unknown,state:string){
  if(typeof value!=='string'||value.length>8192)throw new ControlError('請貼上 Google 授權碼或完整回傳網址');
  let code=value.trim();
  if(/^https?:/i.test(code)){
    let callback:URL;
    try{callback=new URL(code)}catch{throw new ControlError('Google 回傳網址格式不正確')}
    if(callback.origin+callback.pathname!==redirect||callback.username||callback.password||callback.hash){
      throw new ControlError('請貼上 Google 授權完成後的回傳網址');
    }
    if(callback.searchParams.getAll('state').length!==1||callback.searchParams.get('state')!==state){
      throw new ControlError('這是另一次授權的網址，請使用松音這次開啟的 Google 授權');
    }
    const codes=callback.searchParams.getAll('code');
    code=codes.length===1?codes[0]:'';
  }
  if(code.length<10||code.length>4096||/\s/.test(code)){
    throw new ControlError('請貼上 Google 授權碼或完整回傳網址');
  }
  return code;
}
export async function completeAuth(user:string,value:unknown){
  const row=await authRow(user);
  if(!row?.pending)throw new ControlError('請先按「連接 Google 帳號」');
  const pending=await unseal(user,row.pending);
  if(pending.expires<now())throw new ControlError('連接時間已過，請重新開始');
  const code=authorizationCode(value,pending.state);
  const claim=await db().prepare('UPDATE songyin_colab_auth SET pending=NULL WHERE owner=? AND pending=?').bind(user,row.pending).run();
  if(!claim.meta.changes)throw new ControlError('這次授權正在處理，請重新整理');
  const token=await tokenRequest({grant_type:'authorization_code',code,code_verifier:pending.verifier,redirect_uri:redirect});
  if(!token.refresh_token)throw new ControlError('Google 未提供持續連線授權，請重新連接');
  const response=await fetch('https://www.googleapis.com/oauth2/v2/userinfo',{headers:{Authorization:'Bearer '+token.access_token},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new ControlError('無法驗證 Google 帳號',401);
  const profile:any=await response.json();
  if(profile.verified_email!==true||String(profile.email).toLowerCase()!==administratorEmail()){
    throw new ControlError('請以工作室管理員的 Google 帳號完成驗證。',403);
  }
  await db().prepare('UPDATE songyin_colab_auth SET credentials=?,email=?,updated_at=? WHERE owner=?').bind(await seal(user,{...token,expires_at:now()+token.expires_in*1000}),String(profile.email||''),now(),user).run();
  return {connected:true,email:profile.email};
}
export async function colab(user:string,path:string,method='GET',query:Record<string,string>={},xsrf?:string,body?:BodyInit,timeoutMs=25000){const u=new URL('/tun/m/'+path,'https://colab.research.google.com');u.search=new URLSearchParams({authuser:'0',...query}).toString();const h:Record<string,string>={Authorization:'Bearer '+await accessToken(user),Accept:'application/json','X-Colab-Client-Agent':'colab-cli'};if(xsrf)h['X-Goog-Colab-Token']=xsrf;const r=await fetch(u,{method,headers:h,body,signal:AbortSignal.timeout(timeoutMs)});if(!r.ok)throw new ControlError(({401:'Google 連線已過期，請重新連接。',403:'Google 尚未允許這項 Colab 操作，請確認授權與方案。',400:'Colab 不接受此 GPU 設定，請檢查可用資源。',412:'目前沒有可用的所選 GPU，請稍後重試或自行選擇其他 GPU。',429:'Google 暫時限制請求，請稍候再試。'} as Record<number,string>)[r.status]||'Colab 暫時沒有回應，請重新檢查連線。',r.status===401?401:502,r.status);const text=await r.text();return text?JSON.parse(text.replace(/^\)\]\}'\n/,'')):{} }
export async function release(user:string,endpoint:string){if(!endpoint)throw new ControlError('缺少本工作室的 GPU 記錄');const path='unassign/'+encodeURIComponent(endpoint);const first=await colab(user,path);await colab(user,path,'POST',{},first.token)}
