import {workspacePage} from '../../../lib/workspace-page';
import {availableSection} from '../../../lib/workspace-sections';

export async function GET(request:Request,{params}:{params:Promise<{section:string}>}){
  const {section}=await params;
  return availableSection('admin',section)?workspacePage(request,'admin',section):new Response('找不到頁面。',{status:404});
}
