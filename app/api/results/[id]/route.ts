import {studioIdentity} from '../../../../lib/studio-access';
import {ControlError,db,sharedRuntimeOwner} from '../../../../lib/colab-auth';
import {runSavedUpscale} from '../../../../lib/colab-controller';
import {sameOrigin} from '../../../../lib/studio-validation';
import {jobIdPattern,mediaKey,serveMedia,lawfulFile,putMediaStream,types} from '../../../../lib/studio-media';

export async function GET(request:Request, {params}:{params:Promise<{id:string}>}){
  let user:string;
  try{const identity=await studioIdentity(request);if(!identity)throw new Error();user=identity.id}catch{return new Response('請先登入',{status:401})}
  const {id}=await params;
  if(!jobIdPattern.test(id))return new Response('找不到作品',{status:404});
  const q=new URL(request.url).searchParams;
  return serveMedia(request,mediaKey(user,id,q.has('poster')),!q.has('download'));
}

export const HEAD=GET;

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  const json=(body:unknown,status:number)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
  try{sameOrigin(request)}catch{return json({error:'請由作品播放器送出。'},403)}
  try{
    const identity=await studioIdentity(request);
    if(!identity)return json({error:'請先登入。'},401);
    if(Number(request.headers.get('content-length')||0)>1024)return json({error:'資料過大。'},413);
    const raw=await request.text();
    if(raw.length>1024)return json({error:'資料過大。'},413);
    let input;
    try{input=JSON.parse(raw)}catch{return json({error:'送出資料不正確。'},400)}
    if(!input||typeof input!=='object'||Array.isArray(input))return json({error:'送出資料不正確。'},400);
    const runtimeOwner=identity.role==='administrator'?identity.id:await sharedRuntimeOwner();
    if(!runtimeOwner)return json({error:'創作服務尚未就緒。'},409);
    return json(await runSavedUpscale(runtimeOwner,identity,(await params).id,input),202);
  }catch(error){
    if(error instanceof ControlError&&[400,404,409].includes(error.status)){
      return json({error:error.message},error.status);
    }
    return json({error:'暫時無法送出放大工作，請稍後再試。'},503);
  }
}

export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}){
  let user:string;
  try{sameOrigin(request);const identity=await studioIdentity(request);if(!identity)throw new Error();user=identity.id}catch{return Response.json({error:'請由私人工作室收錄作品。'},{status:403})}
  const {id}=await params;
  if(!jobIdPattern.test(id))return Response.json({error:'找不到作品。'},{status:404});
  try{
    const record=await db().prepare("SELECT result,kind FROM songyin_jobs WHERE owner=? AND id=? AND state='done'")
      .bind(user,id).first<{result:string|null,kind:string}>();
    if(!record?.result)return Response.json({error:'找不到原作品紀錄。'},{status:404});
    const result=JSON.parse(record.result);
    const poster=new URL(request.url).searchParams.has('poster');
    if(poster&&!result.archived)return Response.json({error:'請先收錄作品原檔。'},{status:409});
    if(!poster&&result.archived)return Response.json({result});
    const ext=String(result.file??'').split('.').pop()?.toLowerCase()||'';
    const type=poster?'image/jpeg':types[ext];
    const size=Number(request.headers.get('x-result-size'));
    const validSize=Number.isSafeInteger(size)&&size>0&&(poster?size<=2*1024*1024:size===result.bytes&&size<=100*1024*1024);
    if(!type||!validSize||!request.body||!lawfulFile(id,result.file)){
      return Response.json({error:'請選擇這項作品的原始檔案，檔案格式或大小與記錄不符。'},{status:400});
    }
    const media=poster?result.media:measurements(request.headers.get('x-result-media'),ext);
    await putMediaStream(mediaKey(user,id,poster),request.body,size,{httpMetadata:{contentType:type}});
    const saved={...result,archived:true,archiveError:null,hasPoster:poster,media};
    await db().prepare('UPDATE songyin_jobs SET result=? WHERE owner=? AND id=?').bind(JSON.stringify(saved),user,id).run();
    return Response.json({result:saved});
  }catch{return Response.json({error:'未能收錄原始作品。請確認檔案可播放後重試。'},{status:502})}
}

function measurements(value:string|null,ext:string){
  const input=JSON.parse(value||'{}');
  const result:Record<string,string|number>={format:ext.toUpperCase()};
  for(const field of ['duration','width','height','fps','sampleRate','channels']){
    const number=input[field];
    if(typeof number==='number'&&Number.isFinite(number)&&number>0&&number<1000000)result[field]=number;
  }
  for(const field of ['videoCodec','audioCodec']){
    const codec=input[field];
    if(typeof codec==='string'&&/^[A-Za-z0-9._-]{1,16}$/.test(codec))result[field]=codec;
  }
  return result;
}
