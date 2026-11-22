import {workspacePage} from '../lib/workspace-page';
import {administratorIdentity,creatorIdentity} from '../lib/studio-access';
export async function GET(request:Request){
  if(await creatorIdentity(request))return workspacePage(request,'creator');
  return workspacePage(request,await administratorIdentity(request)?'admin':'creator');
}
