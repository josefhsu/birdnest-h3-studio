import {workspacePage} from '../../lib/workspace-page';
export function GET(request:Request){return workspacePage(request,'admin')}
