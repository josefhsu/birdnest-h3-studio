import {owner,sameOrigin} from '../../../../lib/studio-validation';
import {creatorIdentity} from '../../../../lib/studio-access';
import {beginAuth,completeAuth,ControlError,isAdministrator} from '../../../../lib/colab-auth';
import {controllerStatus,startRuntime,advanceRuntime,stopRuntime,activity,runJobs,importResult,generationQueue,removeQueuedGeneration} from '../../../../lib/colab-controller';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store','Referrer-Policy':'no-referrer'}});
function error(e:unknown){return json({error:e instanceof ControlError?e.message:'連線暫時無法完成，請稍後重新檢查。'},e instanceof ControlError?e.status:503)}
export async function GET(request:Request){
 let user;try{user=owner(request)}catch{return json({error:'請先登入私人工作室'},401)}
 const action=new URL(request.url).pathname.split('/').pop();
 if(action!=='status'&&action!=='queue')return json({error:'無此操作'},404);
 try{
  if(await creatorIdentity(request)||!await isAdministrator(user))return json({error:'請先完成管理員 Google 驗證。'},403);
  return json(action==='queue'?await generationQueue(user):await controllerStatus(user));
 }catch(e){return error(e)}
}
export async function POST(request:Request){
 let user;try{user=owner(request);sameOrigin(request)}catch{return json({error:'請登入並由私人工作室操作'},403)}
 try{
  const raw=await request.text();
  if(raw.length>20000)throw new ControlError('資料過大',413);
  const body=raw?JSON.parse(raw):{};
  const action=new URL(request.url).pathname.split('/').pop();
  if(await creatorIdentity(request))return json({error:'請先切換至管理員後台。'},403);
  if(action==='auth-start')return json(await beginAuth(user));
  if(action==='auth-complete')return json(await completeAuth(user,body.code));
  if(!await isAdministrator(user))return json({error:'此操作限 Google 驗證的管理員。'},403);
  switch(action){
   case'start':return json(await startRuntime(user,body.settings));
   case'advance':return json(await advanceRuntime(user,false,body.recheckAssignment===true));
   case'drive-resume':return json(await advanceRuntime(user,true));
   case'stop':return json(await stopRuntime(user));
   case'activity':return json(await activity(user));
   case'run':return json(await runJobs(user,body.ids,body.confirmed,body.expected));
   case'import-result':return json(await importResult(user,body.id));
   case'queue':return json(await removeQueuedGeneration(user,body));
   default:return json({error:'無此操作'},404);
  }
 }catch(e){return error(e)}
}
