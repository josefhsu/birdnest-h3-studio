import page from './workspace-template.html?raw';
import {administratorIdentity,creatorIdentity} from './studio-access';
import {creatorVideoSettings} from './studio-validation';
import {scriptLabNames} from '../public/script-lab-catalog.mjs';
import {sectionNames,sectionPath,type WorkspaceMode,type WorkspaceSection} from './workspace-sections';

const scriptLabOptions=Object.entries(scriptLabNames)
  .map(([id,label])=>'<option value="'+id+'">'+label+'</option>').join('\n');
const headers={'content-type':'text/html; charset=utf-8','cache-control':'no-store'};
const rabbitSign=`<a class="rabbit-sign" href="https://sd.aiarttw.com" target="_blank" rel="noopener noreferrer">
  <strong>無審核的AI.唯粉兔</strong>
  <span>歡迎不想受限的你</span>
</a>`;
const loginHeader=`<header class="login-header">${rabbitSign}</header>`;

const adminLogin=`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>管理員登入｜鳥巢H3大師</title>
<link rel="stylesheet" href="/studio.css"></head><body class="admin-login">
${loginHeader}
<main class="panel">
  <h1>鳥巢H3大師</h1>
  <h2>管理員登入</h2>
  <button id="admin-google" class="deploy" type="button">使用 Google 驗證</button>
  <form id="admin-google-form" hidden>
    <a id="admin-google-link" class="secondary" target="_blank" rel="noopener noreferrer">開啟 Google 授權</a>
    <label for="admin-google-code">Google 授權碼或完整回傳網址</label>
    <input id="admin-google-code" type="password" required autocomplete="off" spellcheck="false">
    <button type="submit" class="deploy">完成管理員驗證</button>
  </form>
  <p id="admin-google-status" role="status"></p>
</main><script src="/admin-login.js"></script></body></html>`;
const creatorLogin=`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>創作者登入｜鳥巢H3大師</title>
<link rel="stylesheet" href="/studio.css"></head><body class="admin-login">
${loginHeader}
<main class="panel">
  <h1>鳥巢H3大師</h1>
  <h2>創作者登入</h2>
  <p>作品與目前的瀏覽器及對外 IP 綁定。換網路後請重新登入。</p>
  __LOGIN_MESSAGE__
  <form action="/api/creator/login" method="post">
    __LOGIN_DESTINATION__
    <label for="creator-login-username">帳號</label>
    <input id="creator-login-username" name="username" autocomplete="username" required maxlength="80">
    <label for="creator-login-password">密碼</label>
    <input id="creator-login-password" name="password" type="password" autocomplete="current-password" required maxlength="80">
    <button class="deploy" type="submit">登入</button>
  </form>
  <p><a class="scope-link" href="/admin">管理員登入</a></p>
</main></body></html>`;

export async function workspacePage(request:Request,mode:WorkspaceMode,requested?:WorkspaceSection){
  const creator=mode==='creator';
  const section=requested||'create';
  const destination=requested?sectionPath(mode,section):'/'+mode;
  const member=await creatorIdentity(request);
  const admin=await administratorIdentity(request);
  if(!creator){
    if(!admin){
      if(!request.headers.get('oai-authenticated-user-id')){
        return Response.redirect(new URL('/signin-with-chatgpt?return_to='+encodeURIComponent(destination),request.url),302);
      }
      return new Response(adminLogin,{headers});
    }
    if(member){
      const switchPage=creatorLogin.replace('創作者登入','切換至管理員後台')
        .replace('<h2>創作者登入</h2>','<h2>切換至管理員後台</h2>')
        .replace(/__LOGIN_MESSAGE__[\s\S]*?<\/form>/,'<form action="/api/creator/logout?next=admin'+(requested?'&amp;section='+section:'')+'" method="post"><button class="deploy" type="submit">結束創作者登入並切換</button></form>')
        .replace('/admin">管理員登入','/creator">返回創作介面');
      return new Response(switchPage,{headers});
    }
  }else if(!member&&!admin){
    const outcome=new URL(request.url).searchParams.get('login');
    const message=outcome==='failed'?'帳號或密碼不正確。':outcome==='network'?'目前無法確認連線 IP，請重新載入後再登入。':'';
    return new Response(creatorLogin.replace('__LOGIN_MESSAGE__',message?'<p role="alert">'+message+'</p>':'')
      .replace('__LOGIN_DESTINATION__',requested?'<input type="hidden" name="section" value="'+section+'">':''),{headers});
  }
  let html=page;
  if(creator)html=html.replace(/<!-- admin-only -->[\s\S]*?<!-- \/admin-only -->/g,'');
  html=html.replace('__WORKSPACE__',mode)
    .replaceAll('__WORKSPACE_BASE__','/'+mode)
    .replace('__ACTIVE_SECTION__',section)
    .replaceAll('__SECTION_TITLE__',sectionNames[section])
    .replaceAll('__SCRIPT_LAB_OPTIONS__',scriptLabOptions)
    .replace(/data-show-on="([a-z ]+)"/g,(attribute,sections:string)=>
      attribute+(sections.split(' ').includes(section)?'':' hidden'))
    .replace(/data-section="([a-z]+)"/g,(attribute,target:string)=>
      attribute+(target===section?' class="active" aria-current="page"':''))
    .replace('__RABBIT_SIGN__',rabbitSign)
    .replace('__DRAFT_SCOPE__',creator&&member?member.id:'')
    .replace('__CREATOR_VIDEO_SETTINGS__',creator?[
      'data-video-resolution="'+creatorVideoSettings.resolution+'"',
      'data-video-seconds="'+creatorVideoSettings.seconds+'"',
      'data-video-upscale="'+creatorVideoSettings.upscale+'"',
    ].join(' '):'')
    .replace('__SCOPE_ACTION__',creator
      ?admin?'<a class="scope-link" data-scope-link="admin" href="'+sectionPath('admin',section)+'">管理員後台</a>':''
      :'<a class="scope-link" data-scope-link="creator" href="'+sectionPath('creator',section)+'">一般使用者介面</a>');
  html=html.replace('__CREATOR_LOGOUT__',creator&&member?
    '<form action="/api/creator/logout" method="post"><button class="scope-link" type="submit">登出</button></form>':'');
  return new Response(html,{headers});
}
