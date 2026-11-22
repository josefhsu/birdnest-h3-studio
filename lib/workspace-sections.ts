export const sectionNames={create:'創作',compute:'運算',storage:'儲存',history:'記錄',queue:'排隊'} as const;
export type WorkspaceSection=keyof typeof sectionNames;
export type WorkspaceMode='admin'|'creator';

export function isWorkspaceSection(value:unknown):value is WorkspaceSection{
  return typeof value==='string'&&Object.hasOwn(sectionNames,value);
}
export function availableSection(mode:WorkspaceMode,value:unknown):value is WorkspaceSection{
  return isWorkspaceSection(value)&&(mode==='admin'||value!=='compute'&&value!=='queue');
}
export function sectionPath(mode:WorkspaceMode,section:WorkspaceSection){
  return '/'+mode+'/'+(availableSection(mode,section)?section:'create');
}
