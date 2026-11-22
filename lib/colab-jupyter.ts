import {ControlError,b64,unb64} from './colab-auth';
export type Proxy={url:string,token:string};
export function proxyURL(p:Proxy,path:string){const u=new URL(p.url);if(u.protocol!=='https:'||!u.hostname.endsWith('.colab.dev'))throw new ControlError('Colab 回傳的執行階段網址無效',502);const [pathname,query]=path.split('?');u.pathname=u.pathname.replace(/\/$/,'')+'/'+pathname.replace(/^\//,'');for(const [k,v] of new URLSearchParams(query))u.searchParams.set(k,v);u.searchParams.set('authuser','0');u.searchParams.set('colab-runtime-proxy-token',p.token);return u}
export async function remote(p:Proxy,path:string,method='GET',body?:unknown){const r=await fetch(proxyURL(p,path),{method,headers:{'X-Colab-Runtime-Proxy-Token':p.token,'X-Colab-Client-Agent':'colab-cli',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});if(r.status===404&&method==='GET')return null;if(!r.ok)throw new ControlError('Colab 執行階段尚未回應，請稍後重新檢查。',502);return r.json() as Promise<any>}
export async function writeFile(p:Proxy,path:string,value:string|Uint8Array,chunk?:number){return remote(p,'api/contents/'+path,'PUT',{type:'file',format:'base64',name:path.split('/').pop(),path,content:b64(typeof value==='string'?new TextEncoder().encode(value):value),...(chunk!==undefined?{chunk}:{})})}
export async function readJSON(p:Proxy,path:string){const r=await remote(p,'api/contents/'+path+'?content=1');if(!r)return null;return JSON.parse(r.format==='base64'?new TextDecoder().decode(unb64(r.content)):r.content)}
export function decodeMessage(value:string|ArrayBuffer){if(typeof value==='string')return JSON.parse(value);const view=new DataView(value);const count=view.getUint32(0);const start=view.getUint32(4);const end=count>1?view.getUint32(8):value.byteLength;if(count<1||count>100||start>=end||end>value.byteLength)throw new Error('Invalid Jupyter frame');return JSON.parse(new TextDecoder().decode(new Uint8Array(value,start,end-start)))}
export async function execute(p:Proxy,kernel:string,session:string,code:string,options:{onDrive?:(m:any)=>Promise<boolean>;timeout?:number}={}){
 const u=proxyURL(p,'api/kernels/'+encodeURIComponent(kernel)+'/channels');u.searchParams.set('session_id',session);
 const abort=new AbortController();
 const connectTimeout=setTimeout(()=>abort.abort(),20000);
 let upgrade:Response;
 try{
  upgrade=await fetch(u,{headers:{Upgrade:'websocket','X-Colab-Runtime-Proxy-Token':p.token,'X-Colab-Client-Agent':'colab-cli'},signal:abort.signal});
 }finally{
  clearTimeout(connectTimeout);
 }
 const ws=upgrade.webSocket;if(!ws)throw new ControlError('無法建立 Colab 控制連線',502);if('binaryType' in ws)(ws as WebSocket & {binaryType:string}).binaryType='arraybuffer';ws.accept();
 const make=(type:string,content:any,channel='shell',parent={})=>({header:{msg_id:crypto.randomUUID(),session,username:'songyin',date:new Date().toISOString(),msg_type:type,version:'5.3'},parent_header:parent,metadata:{},content,channel,buffers:[]});
 const msg=make('execute_request',{code,silent:false,store_history:false,user_expressions:{},allow_stdin:true,stop_on_error:true});
 const id=msg.header.msg_id;
 return new Promise<{output:string,drive?:any}>( (resolve,reject)=>{
  let output='',reply=false,idle=false,ended=false,handling=false;const finish=(e?:Error,drive?:any)=>{if(ended)return;ended=true;clearTimeout(timer);try{ws.close(1000)}catch{}e?reject(e):resolve({output,drive})};
  const timer=setTimeout(()=>finish(new ControlError('Colab 執行逾時，請重新檢查連線。',504)),options.timeout||35000);
  ws.addEventListener('message',async(event)=>{try{const m=decodeMessage(event.data as string|ArrayBuffer);if(m.header?.msg_type==='colab_request'&&m.content?.request?.authType==='dfs_ephemeral'&&!handling&&!ended){handling=true;if(options.onDrive&&await options.onDrive(m)){if(ended)return;ws.send(JSON.stringify(make('input_reply',{value:{type:'colab_reply',colab_msg_id:m.metadata.colab_msg_id}},'stdin',m.header)));handling=false}else finish(undefined,m);return}if(m.parent_header?.msg_id!==id)return;const t=m.header.msg_type;if(t==='stream')output=(output+m.content.text).slice(-16000);if(t==='error')throw new ControlError('Colab 執行失敗：'+String(m.content.evalue).slice(0,400),502);if(t==='execute_reply'){if(m.content.status==='error')throw new ControlError('Colab 無法完成這個步驟',502);reply=true}if(t==='status'&&m.content.execution_state==='idle')idle=true;if(reply&&idle)finish()}catch(e){finish(e instanceof Error?e:new Error('Colab protocol error'))}});
  ws.addEventListener('error',()=>finish(new ControlError('Colab 控制連線中斷，請重新檢查。',502)));
  ws.addEventListener('close',()=>{if(!ended)finish(new ControlError('Colab 控制連線已關閉，請重新檢查。',502))});ws.send(JSON.stringify(msg));
 });
}
