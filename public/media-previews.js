(() => {
  'use strict';
  const icon={image:'▧',video:'▶',audio:'▂▅▇▃▆▂'};
  const label={image:'圖片',video:'影片',audio:'音訊'};
  const cleanup=new WeakMap();
  const panel=document.createElement('section');
  panel.id='asset-preview';
  panel.className='asset-preview';
  panel.setAttribute('role','dialog');
  panel.setAttribute('aria-labelledby','asset-preview-title');
  const popover=typeof panel.showPopover==='function';
  if(popover)panel.setAttribute('popover','manual');
  panel.hidden=true;
  const title=document.createElement('span');
  title.id='asset-preview-title';
  const closeButton=document.createElement('button');
  closeButton.type='button';
  closeButton.className='asset-preview-close';
  closeButton.textContent='×';
  closeButton.setAttribute('aria-label','關閉素材預覽');
  const header=document.createElement('div');
  header.className='asset-preview-header';
  header.append(title,closeButton);
  const stage=document.createElement('div');
  stage.className='asset-preview-stage';
  panel.append(header,stage);
  let current=null;
  let player=null;
  let pinned=false;
  let leaveTimer;

  function stopMedia(media){
    if(!(media instanceof HTMLMediaElement))return;
    media.pause();
    if(media.hasAttribute('src')){
      media.removeAttribute('src');
      media.load();
    }
  }
  function close(restoreFocus=false){
    clearTimeout(leaveTimer);
    if(!current)return;
    const {trigger}=current;
    current=null;
    pinned=false;
    trigger?.setAttribute('aria-expanded','false');
    if(popover&&panel.matches(':popover-open'))panel.hidePopover();
    panel.hidden=true;
    stopMedia(player);
    player=null;
    stage.replaceChildren();
    panel.remove();
    if(restoreFocus&&trigger?.isConnected)trigger.focus({preventScroll:true});
  }
  function place(){
    if(!current)return;
    if(!current.button.isConnected){close();return}
    const rect=current.button.getBoundingClientRect();
    const card=current.card.getBoundingClientRect();
    const width=document.documentElement.clientWidth;
    const height=window.innerHeight;
    if(rect.bottom<0||rect.top>height||!rect.width){close();return}
    const w=panel.offsetWidth,h=panel.offsetHeight,gap=8;
    let left=card.right+gap;
    let top=rect.top;
    if(left+w+gap>width){
      if(card.left-w-gap>=gap)left=card.left-w-gap;
      else{
        left=rect.left;
        top=card.bottom+h+2*gap<=height?card.bottom+gap:card.top-h-gap;
      }
    }
    panel.style.left=Math.max(gap,Math.min(left,width-w-gap))+'px';
    panel.style.top=Math.max(gap,Math.min(top,height-h-gap))+'px';
  }
  function art(kind,className){
    const glyph=document.createElement('span');
    glyph.className=className;
    glyph.setAttribute('aria-hidden','true');
    glyph.textContent=icon[kind]||'◇';
    return glyph;
  }
  function open(entry,freeze){
    clearTimeout(leaveTimer);
    if(current===entry){
      if(freeze){pinned=true;closeButton.focus({preventScroll:true})}
      return;
    }
    if(current&&pinned&&!freeze)return;
    close();
    current=entry;
    pinned=freeze;
    entry.trigger?.setAttribute('aria-expanded','true');
    title.textContent=entry.name;
    const host=entry.button.closest('dialog[open]')||document.body;
    host.append(panel);
    panel.hidden=false;
    if(popover)panel.showPopover();
    place();
    stage.dataset.kind=entry.kind;
    const media=document.createElement(entry.kind==='image'?'img':entry.kind);
    player=media;
    if(entry.kind==='image')media.alt=entry.name;
    else{
      media.controls=true;
      media.playsInline=true;
      media.preload='metadata';
      media.setAttribute('aria-label',entry.name);
    }
    if(entry.kind==='audio')stage.append(art('audio','asset-preview-wave'));
    stage.append(media);
    media.addEventListener('error',()=>{
      if(player!==media)return;
      const unavailable=document.createElement('p');
      unavailable.textContent='此瀏覽器無法預覽這個格式。';
      stage.replaceChildren(unavailable);
    },{once:true});
    media.src=entry.source;
    if(entry.kind==='video'){
      media.muted=true;
      media.loop=true;
      // Hover previews play silently. The normal player can turn sound on.
      media.play().catch(()=>{});
    }
    if(freeze)closeButton.focus({preventScroll:true});
  }
  function leave(entry){
    if(!entry||current!==entry||pinned)return;
    clearTimeout(leaveTimer);
    leaveTimer=setTimeout(()=>{
      if(!panel.contains(document.activeElement))close();
    },240);
  }
  closeButton.addEventListener('click',()=>close(true));
  panel.addEventListener('pointerenter',()=>clearTimeout(leaveTimer));
  panel.addEventListener('pointerleave',()=>leave(current));
  document.addEventListener('pointerdown',event=>{
    if(current&&!panel.contains(event.target)&&!current.card.contains(event.target))close();
  },true);
  document.addEventListener('keydown',event=>{
    if(event.key!=='Escape'||!current)return;
    event.preventDefault();
    event.stopPropagation();
    close(pinned||panel.contains(document.activeElement));
  },true);
  document.addEventListener('scroll',place,true);
  window.addEventListener('resize',place);

  function thumbnail(file,card,{source:remoteSource,poster,decorative=false,hover=false,previewControl}={}){
    const kind=file.type?.split('/')[0];
    const button=document.createElement(decorative?'span':'button');
    button.className='asset-thumbnail';
    button.dataset.kind=kind;
    const trigger=previewControl||(decorative?null:button);
    if(decorative)button.setAttribute('aria-hidden','true');
    if(trigger){
      trigger.type='button';
      trigger.setAttribute('aria-label','預覽'+(label[kind]||'素材')+' '+file.name);
      trigger.setAttribute('aria-haspopup','dialog');
      trigger.setAttribute('aria-controls',panel.id);
      trigger.setAttribute('aria-expanded','false');
    }
    button.append(art(kind,'asset-thumbnail-icon'));
    const local=file.blob;
    if((!local&&!file.id&&!remoteSource)||!Object.hasOwn(label,kind)){
      if(trigger)trigger.disabled=true;
      return button;
    }
    const source=local
      ?URL.createObjectURL(local.type===file.type?local:new Blob([local],{type:file.type}))
      :remoteSource||'/api/assets/'+encodeURIComponent(file.id)+'?preview=1';
    const entry={button,trigger,card,source,kind,name:file.name};
    const controller=new AbortController();
    const {signal}=controller;
    if(!decorative||hover){
      card.addEventListener('pointerenter',event=>{if(event.pointerType==='mouse'&&!event.buttons)open(entry,false)},{signal});
      card.addEventListener('pointerleave',()=>leave(entry),{signal});
    }
    trigger?.addEventListener('click',()=>{
      if(current===entry&&pinned)close(true);
      else open(entry,true);
    },{signal});
    let thumb=null;
    let observer=null;
    function loadFrame(usePoster=Boolean(poster)){
      observer?.disconnect();
      const image=kind==='image'||usePoster;
      const frame=document.createElement(image?'img':'video');
      thumb=frame;
      if(image){frame.alt='';frame.decoding='async'}
      else{
        frame.muted=true;
        frame.playsInline=true;
        frame.preload='metadata';
        frame.setAttribute('aria-hidden','true');
      }
      frame.addEventListener('error',()=>{
        frame.remove();
        if(usePoster)loadFrame(false);
      },{once:true,signal});
      frame.addEventListener(image?'load':'loadeddata',()=>frame.classList.add('asset-thumbnail-loaded'),{once:true,signal});
      button.append(frame);
      frame.src=usePoster?poster:image?source:source+'#t=0.1';
    }
    if(kind==='image'||kind==='video'){
      if(typeof IntersectionObserver==='function'){
        observer=new IntersectionObserver(entries=>{if(entries.some(item=>item.isIntersecting))loadFrame()});
        observer.observe(button);
      }else loadFrame();
    }
    cleanup.set(button,()=>{
      if(current===entry)close();
      controller.abort();
      observer?.disconnect();
      stopMedia(thumb);
      if(local)URL.revokeObjectURL(source);
    });
    return button;
  }
  function clear(container){
    for(const button of container.querySelectorAll('.asset-thumbnail')){
      cleanup.get(button)?.();
      cleanup.delete(button);
    }
  }
  window.songyinMedia={thumbnail,clear,close};
})();
