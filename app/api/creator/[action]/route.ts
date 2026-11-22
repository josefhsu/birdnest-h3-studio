import {ControlError,sharedRuntimeOwner} from '../../../../lib/colab-auth';
import {controllerStatus,getRuntime,publicRuntime,runJobs} from '../../../../lib/colab-controller';
import {closeCreatorSession,createCreatorSession,sharedCreatorLogin,studioIdentity} from '../../../../lib/studio-access';
import {sameOrigin} from '../../../../lib/studio-validation';
import {availableSection,sectionPath} from '../../../../lib/workspace-sections';

const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
function creatorState(runtime:ReturnType<typeof publicRuntime>,ownJob:boolean){
  const phase=runtime&&['ready','uploading','running'].includes(runtime.phase)?runtime.phase:'offline';
  if(!ownJob)return {phase:['uploading','running'].includes(phase)?'busy':phase};
  return {phase,stage:runtime?.stage,operation:runtime?.operation,jobProgress:runtime?.jobProgress,progress:runtime?.progress};
}
function errorResponse(error:unknown){
  const unavailable=error instanceof ControlError&&[400,409].includes(error.status);
  return json({error:unavailable?'目前無法送出，請確認創作服務已就緒並重新選擇工作。':'連線暫時無法完成，請稍後再試。'},unavailable?409:503);
}
export async function GET(request:Request){
  if(!new URL(request.url).pathname.endsWith('/status'))return json({error:'無此操作。'},404);
  try{
    const identity=await studioIdentity(request);
    if(!identity)return json({error:'請先登入。'},401);
    const admin=identity.role==='administrator'?identity.id:await sharedRuntimeOwner();
    const runtime=admin?await getRuntime(admin):null;
    const ownJob=(runtime?.data.jobOwner||runtime?.owner)===identity.id;
    const selected=ownJob&&admin&&runtime?.phase==='running'
      ?(await controllerStatus(admin)).runtime:publicRuntime(runtime);
    return json({connected:true,runtime:creatorState(selected,ownJob)});
  }catch(error){return errorResponse(error)}
}
export async function POST(request:Request){
  try{sameOrigin(request)}catch{return json({error:'請由工作室操作。'},403)}
  const url=new URL(request.url);
  try{
    if(url.pathname.endsWith('/logout')){
      const admin=url.searchParams.get('next')==='admin';
      const section=url.searchParams.get('section');
      return closeCreatorSession(admin&&availableSection('admin',section)?sectionPath('admin',section):admin?'/admin':'/creator');
    }
    const raw=await request.text();
    if(raw.length>2048)return json({error:'工作資料過大。'},413);
    if(url.pathname.endsWith('/login')){
      const form=new URLSearchParams(raw);
      const section=form.get('section');
      const next=availableSection('creator',section)?sectionPath('creator',section):'/creator';
      if(!await sharedCreatorLogin(form.get('username'),form.get('password'))){
        return new Response(null,{status:303,headers:{location:next+'?login=failed','cache-control':'no-store'}});
      }
      return await createCreatorSession(request,next);
    }
    if(!url.pathname.endsWith('/run'))return json({error:'無此操作。'},404);
    const identity=await studioIdentity(request);
    if(!identity)return json({error:'請先登入。'},401);
    const {ids,expected}=JSON.parse(raw);
    if(!Array.isArray(ids)||ids.length!==1||typeof ids[0]!=='string')return json({error:'每次只能送出一則生成工作。'},400);
    const admin=identity.role==='administrator'?identity.id:await sharedRuntimeOwner();
    if(!admin)return json({error:'創作服務尚未就緒。'},409);
    const {runtime}=await runJobs(admin,ids,false,expected,identity.id,true);
    return json({runtime:creatorState(runtime,true)});
  }catch(error){return errorResponse(error)}
}
