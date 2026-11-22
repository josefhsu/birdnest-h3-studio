import {env} from 'cloudflare:workers';
import {ControlError,unb64} from './colab-auth';
import {proxyURL,remote,type Proxy} from './colab-jupyter';

export const types:Record<string,string>={
  mp4:'video/mp4',webm:'video/webm',wav:'audio/wav',flac:'audio/flac',mp3:'audio/mpeg',
  png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',
};
export const jobIdPattern=/^job_[a-zA-Z0-9_-]{1,90}$/;
export function lawfulFile(jobId:string, name:unknown){
  if(typeof name!=='string')return false;
  const stem=name.slice(0,name.lastIndexOf('.'));
  return [jobId,jobId+'-poster'].includes(stem)&&Object.hasOwn(types,name.split('.').pop()||'');
}
export function mediaKey(user:string,id:string,poster:boolean){
  return `${user}/results/${id}/${poster?'poster':'media'}`;
}

export async function putMediaStream(key:string,body:ReadableStream,length:number,metadata:R2PutOptions){
  const fixed=new FixedLengthStream(length);
  await Promise.all([
    body.pipeTo(fixed.writable),
    env.BUCKET!.put(key,fixed.readable,metadata),
  ]);
}

async function archiveFile(proxy:Proxy,user:string,id:string,path:string,name:string,length:number,poster=false,chunkBytes?:number){
  if(!lawfulFile(id,name)||!Number.isSafeInteger(length)||length<1||length>512*1024*1024){
    throw new ControlError('成品格式或容量超出站內預覽支援範圍。',400);
  }
  const nameKey=mediaKey(user,id,poster);
  if((await env.BUCKET!.head(nameKey))?.size===length)return;
  const route='files/'+path.split('/').map(encodeURIComponent).join('/');
  const target=proxyURL(proxy,route);
  const response=await fetch(target,{
    headers:{'X-Colab-Runtime-Proxy-Token':proxy.token,'X-Colab-Client-Agent':'colab-cli','Accept-Encoding':'identity'},
    redirect:'error',signal:AbortSignal.timeout(90000)
  }).catch(()=>null);
  const metadata={httpMetadata:{contentType:types[name.split('.').pop()!]},customMetadata:{file:name}};
  if(!response?.ok||!response.body||response.headers.get('content-type')?.startsWith('text/html')||
     (response.headers.has('content-length')&&Number(response.headers.get('content-length'))!==length)){
    // Older Colab proxies sometimes expose only Jupyter's Contents API.
    await response?.body?.cancel();
    if(length<=12*1024*1024){
      const entry=await remote(proxy,'api/contents/'+path.split('/').map(encodeURIComponent).join('/')+'?format=base64&content=1');
      if(entry?.format==='base64'&&typeof entry.content==='string'){
        const decoded=unb64(entry.content);
        if(decoded.byteLength===length){await env.BUCKET!.put(nameKey,decoded,metadata);return}
      }
    }
    if(chunkBytes===8*1024*1024&&!poster&&length>12*1024*1024){
      let offset=0;
      const prefix=path.slice(0,path.lastIndexOf('/')+1)+id+'-chunks/';
      const chunks=new ReadableStream<Uint8Array>({
        async pull(controller){
          try{
            const piece=await remote(proxy,'api/contents/'+prefix+(offset/chunkBytes)+'.part?format=base64&content=1');
            const buffer=piece?.format==='base64'&&typeof piece.content==='string'?unb64(piece.content):null;
            if(buffer?.byteLength!==Math.min(chunkBytes,length-offset))throw new ControlError('影片分段傳輸不完整。',502);
            controller.enqueue(buffer);
            offset+=buffer.byteLength;
            if(offset===length)controller.close();
          }catch(error){controller.error(error)}
        },
      });
      await putMediaStream(nameKey,chunks,length,metadata);
      return;
    }
    throw new ControlError('Colab 未能傳回完整成品，稍後可重新收錄。',502);
  }
  await putMediaStream(nameKey,response.body,length,metadata);
}

export async function archiveResult(proxy:Proxy,user:string,id:string,result:any,folder='content/h3job/out'){
  const chunkBytes=folder==='content/h3job/out'?result.archive_chunk_bytes:undefined;
  await archiveFile(proxy,user,id,folder+'/'+result.file,result.file,result.bytes,false,chunkBytes);
  let hasPoster=false;
  if(result.poster&&result.poster_bytes){
    try{
      await archiveFile(proxy,user,id,folder+'/'+result.poster,result.poster,result.poster_bytes,true);
      hasPoster=true;
    }catch{ /* The original media is still playable if its poster cannot be copied. */ }
  }
  return {...result,archived:true,hasPoster,archiveError:null};
}

function parseRange(value:string,total:number){
  const match=/^bytes=(\d*)-(\d*)$/.exec(value);
  if(!match||(!match[1]&&!match[2])||total<=0)return null;
  const offset=match[1]?Number(match[1]):Math.max(0,total-Number(match[2]));
  const end=match[1]&&match[2]?Math.min(total-1,Number(match[2])):total-1;
  if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(end)||offset>=total||end<offset)return null;
  return {offset,length:end-offset+1};
}

export async function serveMedia(request:Request,key:string,inline:boolean,inlineTypes=Object.values(types)){
  const bucket=env.BUCKET!;
  const head=await bucket.head(key);
  if(!head)return new Response('找不到檔案',{status:404});
  const headers=new Headers({'accept-ranges':'bytes','cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"sandbox; default-src 'none'"});
  const type=head.httpMetadata?.contentType||'application/octet-stream';
  const safeInline=inline&&inlineTypes.includes(type);
  headers.set('content-type',type);
  headers.set('content-disposition',safeInline?'inline':'attachment');
  let range:R2Range|undefined;
  const input=request.headers.get('range');
  if(input){
    const selected=parseRange(input,head.size);
    if(!selected){headers.set('content-range',`bytes */${head.size}`);return new Response(null,{status:416,headers})}
    headers.set('content-range',`bytes ${selected.offset}-${selected.offset+selected.length-1}/${head.size}`);
    headers.set('content-length',String(selected.length));
    range=selected;
  }else headers.set('content-length',String(head.size));
  if(request.method==='HEAD')return new Response(null,{status:range?206:200,headers});
  const file=await bucket.get(key,range?{range}:undefined);
  if(!file)return new Response('找不到檔案',{status:404});
  return new Response(file.body,{status:range?206:200,headers});
}
