import {studioIdentity} from '../../../../lib/studio-access';
import {putMediaStream,serveMedia} from '../../../../lib/studio-media';
import {sameOrigin} from '../../../../lib/studio-validation';
import {extensionTypes,maxBytes} from '../../../../public/h3-references.mjs';

export async function PUT(request:Request,{params}:{params:Promise<{id:string}>}){
  let user:string;
  try{sameOrigin(request);const identity=await studioIdentity(request);if(!identity)throw new Error();user=identity.id}
  catch{return Response.json({error:'請先登入並由工作室上傳。'},{status:403})}
  const {id}=await params;
  if(!/^asset_[a-zA-Z0-9_-]{1,90}$/.test(id))return Response.json({error:'素材編號錯誤。'},{status:400});
  const type=request.headers.get('content-type')||'';
  if(!/^(image|audio|video)\//.test(type))return Response.json({error:'請上傳圖片、影片或音訊。'},{status:415});
  const contentLength=request.headers.get('content-length');
  const length=request.headers.get('x-asset-size')??contentLength;
  const bytes=Number(length);
  if(length===null)return Response.json({error:'無法讀取素材大小，請重新整理後再同步。'},{status:411});
  if(!request.body||!/^\d+$/.test(length)||!Number.isSafeInteger(bytes)||bytes<1||
     (contentLength!==null&&Number(contentLength)!==bytes)){
    return Response.json({error:'素材大小與上傳資料不符，請重新選擇檔案。'},{status:400});
  }
  if(bytes>maxBytes)return Response.json({error:'單一素材不得超過 100 MB。'},{status:413});
  try{
    await putMediaStream(user+'/'+id,request.body,bytes,{httpMetadata:{contentType:type},customMetadata:{owner:user}});
    return Response.json({id,bytes});
  }catch(error){
    console.warn('songyin asset upload failed',{reason:error instanceof Error?error.name:'UnknownError',bytes});
    return Response.json({error:'素材未能完整儲存，請重試同步。'},{status:502});
  }
}
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 let user:string;try{const identity=await studioIdentity(request);if(!identity)throw new Error();user=identity.id}catch{return new Response('請先登入',{status:401})}
 const{id}=await params;if(!/^asset_[a-zA-Z0-9_-]{1,90}$/.test(id))return new Response('不存在',{status:404});
 return serveMedia(request,user+'/'+id,new URL(request.url).searchParams.has('preview'),Object.values(extensionTypes));
}
