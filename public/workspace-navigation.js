(() => {
  'use strict';
  const body=document.body;
  const base='/'+body.dataset.workspace;
  const links=[...document.querySelectorAll('.nav a[data-section]')];
  const sections=[...document.querySelectorAll('[data-show-on]')];
  const scopes=[...document.querySelectorAll('[data-scope-link]')];
  const heading=document.getElementById('workspace-title');
  const routes=new Map(links.map(link=>[link.dataset.section,link]));
  const legacy={'#studio':'create','#gpu':'compute','#options':'compute','#drive-auth':'compute',
    '#storage':'storage','#history':'history','#generation-queue':'queue'};
  function show(section,{historyMode='push',focus=true}={}){
    const link=routes.get(section);
    if(!link)return;
    const changing=body.dataset.activeSection!==section;
    if(changing){
      const dialog=document.getElementById('result-dialog');
      if(dialog?.open)dialog.close();
      window.songyinMedia?.close();
    }
    if(historyMode==='push'&&location.pathname!==link.pathname)history.pushState(null,'',link.pathname);
    if(historyMode==='replace')history.replaceState(null,'',link.pathname+(location.hash==='#drive-auth'?'#drive-auth':''));
    for(const element of sections)element.hidden=!element.dataset.showOn.split(' ').includes(section);
    for(const nav of links){
      const active=nav===link;
      nav.classList.toggle('active',active);
      if(active)nav.setAttribute('aria-current','page');
      else nav.removeAttribute('aria-current');
    }
    for(const scope of scopes){
      const target=scope.dataset.scopeLink;
      scope.href='/'+target+'/'+(target==='creator'&&['compute','queue'].includes(section)?'create':section);
    }
    const title=link.querySelector('span').textContent;
    heading.textContent=title;
    document.title=title+'｜鳥巢H3大師';
    body.dataset.activeSection=section;
    if(changing)document.dispatchEvent(new CustomEvent('studio-sectionchange',{detail:{section}}));
    if(focus){
      heading.focus({preventScroll:true});
      window.scrollTo(0,0);
    }
  }
  function readLocation(){
    const entry=location.pathname==='/'||location.pathname===base;
    const section=entry?(legacy[location.hash]||'create'):location.pathname.split('/').at(-1);
    show(routes.has(section)?section:'create',{historyMode:entry?'replace':null,focus:entry&&Boolean(legacy[location.hash])});
  }
  document.addEventListener('click',event=>{
    if(event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
    const anchor=event.target.closest('a[href]');
    if(!anchor||anchor.target||anchor.hasAttribute('download')||anchor.origin!==location.origin||anchor.search||anchor.hash)return;
    const entry=links.find(link=>link.pathname===anchor.pathname);
    if(!entry)return;
    event.preventDefault();
    show(entry.dataset.section);
  });
  window.addEventListener('popstate',readLocation);
  window.songyinNavigation={show};
  readLocation();
})();
