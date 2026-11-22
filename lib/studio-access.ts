import {env} from 'cloudflare:workers';
import {db,isAdministrator,now,seal,unb64,unseal} from './colab-auth';

const deviceCookie='__Host-h3-device';
const sessionCookie='__Host-h3-creator';
const scopes={device:'h3-creator-device-v1',session:'h3-creator-session-v1'};
const deviceDays=365;
const sessionDays=7;
const deviceId=/^creator-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const networkOwnerId=/^creator-[0-9a-f]{64}$/;
const workerClientIp='2a06:98c0:3600::103';
const encoder=new TextEncoder();

export type Identity={role:'administrator'|'creator';id:string};
type AccessCookie={id:string;expires:number;network?:string};

function readCookie(request:Request,name:string){
  return request.headers.get('cookie')?.split(';').map(part=>part.trim())
    .find(part=>part.startsWith(name+'='))?.slice(name.length+1);
}
async function verifiedCookie(request:Request,name:string,scope:string):Promise<AccessCookie|null>{
  const raw=readCookie(request,name);
  if(!raw||raw.length>1024)return null;
  try{
    const record=await unseal(scope,raw);
    return record&&typeof record.id==='string'&&(deviceId.test(record.id)||networkOwnerId.test(record.id))&&Number.isFinite(record.expires)&&record.expires>now()?record:null;
  }catch{return null}
}
function connectingIp(request:Request){
  // Sites is served by Cloudflare. Use its edge client address, never a forwarded address from the browser.
  const address=request.headers.get('cf-connecting-ip')?.trim();
  if(!address)return null;
  if(/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)){
    const parts=address.split('.').map(Number);
    return parts.every(part=>part<=255)?parts.join('.'):null;
  }
  if(!address.includes(':')||!/^[0-9a-f:.]+$/i.test(address))return null;
  try{
    const normalized=new URL('http://['+address+']/').hostname.slice(1,-1);
    return normalized===workerClientIp?null:normalized;
  }catch{return null}
}
async function networkKey(){
  if(!env.COLAB_ENCRYPTION_KEY)throw new Error('Missing studio encryption key');
  const root=await crypto.subtle.importKey('raw',unb64(env.COLAB_ENCRYPTION_KEY),'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey(
    {name:'HKDF',hash:'SHA-256',salt:new Uint8Array(),info:encoder.encode('h3-creator-network-v1')},
    root,{name:'HMAC',hash:'SHA-256',length:256},false,['sign'],
  );
}
async function fingerprint(key:CryptoKey,scope:string,value:string){
  const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(scope+'\0'+value)));
  return Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
}
function cookie(name:string,value:string,maxAge:number){
  return name+'='+value+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age='+maxAge;
}
export async function creatorIdentity(request:Request):Promise<Identity|null>{
  const address=connectingIp(request);
  if(!address)return null;
  const session=await verifiedCookie(request,sessionCookie,scopes.session);
  if(!session?.network)return null;
  const network=await fingerprint(await networkKey(),'ip',address);
  return session.network===network?{role:'creator',id:session.id}:null;
}
export async function administratorIdentity(request:Request):Promise<Identity|null>{
  const id=request.headers.get('oai-authenticated-user-id');
  return id&&await isAdministrator(id)?{role:'administrator',id}:null;
}
export async function studioIdentity(request:Request):Promise<Identity|null>{
  // On a shared browser an explicit creator session takes precedence for work and storage.
  return await creatorIdentity(request)||await administratorIdentity(request);
}
export async function createCreatorSession(request:Request,next='/creator'){
  const headers=new Headers({'cache-control':'no-store'});
  const address=connectingIp(request);
  if(!address){
    headers.set('location',next+'?login=network');
    return new Response(null,{status:303,headers});
  }
  const key=await networkKey();
  const network=await fingerprint(key,'ip',address);
  const device=await verifiedCookie(request,deviceCookie,scopes.device);
  const browser=device&&deviceId.test(device.id)?device.id:'creator-'+crypto.randomUUID();
  // The first binding preserves this browser's older works. Keep it immutable across simultaneous logins.
  const binding=await db().prepare(`INSERT INTO songyin_creator_network (browser,primary_network) VALUES (?,?)
    ON CONFLICT(browser) DO UPDATE SET primary_network=songyin_creator_network.primary_network
    RETURNING primary_network`).bind(browser,network).first<{primary_network:string}>();
  if(!binding)throw new Error('Missing creator network binding');
  const id=binding.primary_network===network?browser:'creator-'+await fingerprint(key,'owner',browser+'\0'+network);
  const identities=[
    [deviceCookie,scopes.device,deviceDays,{id:browser}],
    [sessionCookie,scopes.session,sessionDays,{id,network}],
  ] as const;
  headers.set('location',next);
  for(const [name,scope,days,claims] of identities){
    const maxAge=days*86400;
    const value=await seal(scope,{...claims,expires:now()+maxAge*1000});
    headers.append('set-cookie',cookie(name,value,maxAge));
  }
  return new Response(null,{status:303,headers});
}
export function closeCreatorSession(next='/creator'){
  return new Response(null,{status:303,headers:{
    'cache-control':'no-store',location:next,'set-cookie':cookie(sessionCookie,'',0),
  }});
}

export async function sharedCreatorLogin(username:string|null,password:string|null){
  const secret=env.CREATOR_SHARED_PASSWORD;
  if(username!==(env.CREATOR_USERNAME?.trim()||'creator')||!password||!secret)return false;
  const hashes=await Promise.all([password,secret].map(value=>crypto.subtle.digest('SHA-256',encoder.encode(value))));
  const [provided,expected]=hashes.map(hash=>new Uint8Array(hash));
  return provided.reduce((difference,byte,index)=>difference|(byte^expected[index]),0)===0;
}
