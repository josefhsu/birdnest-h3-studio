import {labels,mediaType,fileKind,labelAssets,checkReferences,mentions,removeReference,reorderReferenceTags,getLimits,extensionTypes,filesForMode,usesReferenceTags,submissionPrompt} from './h3-references.mjs';
import {sources,promptTemplate} from './h3-prompt-library.mjs';
import {traditionalPrompt} from './h3-prompt-language.mjs';
import {setupScriptLab} from './script-lab.js';
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const names = { video: '影片', image: '圖片', tts: '配音' };
  const loraSelect=$('job-lora');
  const settingsKey = 'colab-h3-settings-preview-v1';
  const scope = document.body.dataset.draftScope;
  const draftKey = 'colab-h3-creator-draft-v1'+(scope?'-'+scope:'');
  const {videoResolution,videoSeconds,videoUpscale}=document.body.dataset;
  const videoSettings=videoResolution&&{
    resolution:videoResolution,seconds:Number(videoSeconds),upscale:Number(videoUpscale),
  };
  const applyVideoSettings=job=>videoSettings&&job.type==='video'?{...job,...videoSettings}:job;
  let voiceSeconds='5';
  let kind = 'video';
  let jobs = [];
  let db;
  let editing=null;
  let stagedAssets=[];
  let menuIndex=0;
  let checkingFiles=false;
  let draggedAsset=null;

  function note(message, error = false) {
    $('job-status').textContent = message;
    $('job-status').classList.toggle('error', error);
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('colab-h3-local-drafts'+(scope?'-'+scope:''), 1);
      req.onupgradeneeded = () => req.result.createObjectStore('jobs', {keyPath: 'id'});
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('無法開啟瀏覽器儲存空間'));
      req.onblocked = () => reject(new Error('瀏覽器儲存空間被其他分頁佔用'));
    });
  }

  function request(mode, action, value) {
    return new Promise((resolve, reject) => {
      if (!db) return reject(new Error('瀏覽器儲存空間尚未準備好'));
      const tx = db.transaction('jobs', mode);
      const req = value === undefined ? tx.objectStore('jobs')[action]() : tx.objectStore('jobs')[action](value);
      let result;
      req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || req.error || new Error('儲存失敗'));
      tx.onabort = () => reject(tx.error || new Error('儲存作業中斷'));
    });
  }

  function updateKind(next) {
    if(kind!==next){editing=null;stagedAssets=[];}
    kind = next;
    if(videoSettings){
      const lock=kind==='video';
      $('job-resolution').disabled=lock;
      $('job-upscale').disabled=lock;
      $('job-seconds').readOnly=lock;
      if(lock){
        $('job-resolution').value=videoSettings.resolution;
        $('job-upscale').value=String(videoSettings.upscale);
        $('job-seconds').value=String(videoSettings.seconds);
        $('upscale-limit').textContent='此帳號的影片規格固定';
      }else if(kind==='tts')$('job-seconds').value=voiceSeconds;
    }
    document.querySelectorAll('.creator-tabs [data-kind]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.kind === kind)));
    $('mode-wrap').hidden = kind !== 'video';
    $('aspect-wrap').hidden = kind === 'tts';
    $('resolution-wrap').hidden = kind !== 'video';
    $('upscale-wrap').hidden = kind !== 'video';
    if(loraSelect)$('lora-wrap').hidden=kind!=='video';
    $('size-wrap').hidden = kind !== 'image';
    $('seconds-wrap').hidden = kind === 'image';
    $('files-label').textContent=kind==='tts'?'參考聲音':'參考素材';
    $('job-files').value='';
    renderReferences();
    $('job-prompt').placeholder = kind === 'tts' ? '輸入配音台詞，並描述希望的聲音與語氣……' : kind === 'image' ? '描述人物、場景、構圖、光線或想修改的細節……' : '描述人物、場景、鏡頭、動作或台詞……';
    persistDraft();
  }

  function refsNote(message,error=false){
    $('reference-status').textContent=message;
    $('reference-status').classList.toggle('error',error);
  }
  const videoMode=()=>$('job-mode').value;
  const textarea=()=>$('job-prompt');
  function frameSlots(){
    const images=stagedAssets.filter(file=>fileKind(file)==='image');
    const unassigned=images.filter(file=>!file.frameSlot);
    const first=images.find(file=>file.frameSlot==='first')||unassigned.shift();
    const last=images.find(file=>file.frameSlot==='last')||unassigned.shift();
    return {first,last};
  }
  const activeFiles=()=>kind==='video'&&videoMode()==='frames'
    ?Object.values(frameSlots()).filter(Boolean):filesForMode(kind,videoMode(),stagedAssets);
  let previousRows=[];
  let previousMode;
  function reorderAssets(source,target,restoreFocus=false){
    const before=activeFiles();
    const from=before.indexOf(source),to=before.indexOf(target);
    if(from<0||to<0||from===to)return;
    const after=[...before];
    after.splice(from,1);
    after.splice(to,0,source);
    const tagged=usesReferenceTags(kind,videoMode());
    if(tagged){
      let i=0;
      stagedAssets=stagedAssets.map(file=>before.includes(file)?after[i++]:file);
      const field=textarea();
      const prompt=reorderReferenceTags(field.value,before,after);
      if(prompt!==field.value){
        const {selectionStart,selectionEnd,selectionDirection}=field;
        field.value=prompt;
        field.setSelectionRange(selectionStart,selectionEnd,selectionDirection);
        persistDraft();
      }
    }else{
      stagedAssets=stagedAssets.map(file=>file===after[0]?{...file,frameSlot:'first'}
        :file===after[1]?{...file,frameSlot:'last'}:file);
    }
    closeReferenceMenu();
    renderReferences();
    if(restoreFocus)$('reference-list').children[to]?.querySelector('.reference-card-target')?.focus();
    refsNote(tagged?'素材已排序，提示詞中的標籤已同步更新。':'已交換首格與尾格。');
  }
  function renderReferences(){
    const mode=videoMode();
    const limits=getLimits(kind,mode);
    const tagged=usesReferenceTags(kind,mode);
    const visibleFiles=activeFiles();
    const data=labelAssets(visibleFiles);
    const counts=Object.keys(labels).map(type=>data.filter(file=>file.kind===type).length);
    $('reference-panel').hidden=limits.total===0;
    $('reference-drop').hidden=limits.total===0;
    $('job-files').accept=Object.entries(extensionTypes).filter(([,mime])=>limits[mime.split('/')[0]]).map(([ext])=>'.'+ext).join(',');
    const limitsText=kind==='video'&&mode==='ref'
      ?`在提示詞輸入 @ 或點素材卡，即可插入標籤。圖片 ${counts[0]}/9 · 影片 ${counts[1]}/3 · 音訊 ${counts[2]}/3 · 合計 ${data.length}/12。影片與音訊各自每段 2–15 秒，各自合計最多 15 秒。每項工作合計 100 MB。`
      :kind==='video'?'依圖片順序套用首格與尾格，送出時會略過素材標籤。':`點素材卡插入標籤。已選 ${data.length}/${limits.total} 個，合計上限 100 MB。`;
    $('files-help').textContent=(data.length>1?'拖曳素材卡可重新排序。':'')+limitsText;
    $('prompt-guide-notes').textContent=kind==='video'&&mode==='ref'
      ?'用標籤指明角色、場景、運鏡或音色的來源。H3 會讀取提示中點名的檔案。台詞可保留原語言，並用 <d> 包住。'
      :kind==='tts'?'描述聲音、情緒、語速和停頓，用音訊標籤指定音色參考。'
      :'說明畫面、光線、鏡頭和可見動作；有首尾格時，交代動作如何連接兩幀。';
    $('insert-reference-tags').hidden=!tagged||!data.length;
    const list=$('reference-list');
    const rowMode=kind+'-'+mode;
    if(previousMode===rowMode&&previousRows.length===visibleFiles.length&&previousRows.every((file,i)=>file===visibleFiles[i]))return;
    previousMode=rowMode;
    previousRows=[...visibleFiles];
    window.songyinMedia.clear(list);
    list.replaceChildren();
    const lastFrame=tagged?null:frameSlots().last;
    for(const [i,file] of data.entries()){
      const asset=visibleFiles[i];
      const item=document.createElement('li');
      item.className='reference-card-row';
      const tag=document.createElement('span');
      tag.textContent=tagged?file.tag:asset===lastFrame?'尾格':'首格';
      tag.className='reference-tag';
      const preview=document.createElement('button');
      preview.className='reference-card-preview';
      const remove=document.createElement('button');
      remove.type='button';
      remove.className='reference-card-remove';
      remove.textContent='×';
      remove.setAttribute('aria-label','移除 '+file.name);
      remove.addEventListener('click',()=>{
        if(tagged)textarea().value=removeReference(textarea().value,file.kind,file.index);
        stagedAssets.splice(stagedAssets.indexOf(asset),1);
        persistDraft();
        renderReferences();
        refsNote(tagged?'已移除檔案並更新同類標籤。':'已移除圖片。');
      });
      const card=document.createElement(tagged?'button':'div');
      card.className='reference-card-target';
      card.setAttribute('aria-label',(tagged?'插入 ':'')+tag.textContent+' · '+file.name);
      card.append(window.songyinMedia.thumbnail(file,item,{decorative:true,hover:true,previewControl:preview}),tag);
      if(tagged){
        card.type='button';
        card.addEventListener('click',()=>insertReference(file));
      }
      if(data.length>1){
        card.draggable=true;
        if(!tagged){card.tabIndex=0;card.setAttribute('role','group')}
        card.setAttribute('aria-keyshortcuts','Alt+ArrowLeft Alt+ArrowRight');
        card.addEventListener('keydown',event=>{
          const offset=event.key==='ArrowLeft'?-1:event.key==='ArrowRight'?1:0;
          if(!event.altKey||!offset)return;
          event.preventDefault();
          reorderAssets(asset,visibleFiles[i+offset],true);
        });
        card.addEventListener('dragstart',event=>{
          draggedAsset=asset;
          event.dataTransfer.effectAllowed='move';
          event.dataTransfer.setData('text/plain',tag.textContent);
          item.classList.add('is-dragging');
          window.songyinMedia.close();
        });
        card.addEventListener('dragend',()=>{
          draggedAsset=null;
          item.classList.remove('is-dragging');
          list.querySelector('.is-drop-target')?.classList.remove('is-drop-target');
        });
        item.addEventListener('dragover',event=>{
          if(!draggedAsset||draggedAsset===asset)return;
          event.preventDefault();
          event.dataTransfer.dropEffect='move';
          list.querySelector('.is-drop-target')?.classList.remove('is-drop-target');
          item.classList.add('is-drop-target');
        });
        item.addEventListener('dragleave',event=>{
          if(!item.contains(event.relatedTarget))item.classList.remove('is-drop-target');
        });
        item.addEventListener('drop',event=>{
          if(!draggedAsset)return;
          event.preventDefault();
          const source=draggedAsset;
          draggedAsset=null;
          reorderAssets(source,asset);
        });
      }
      item.append(card,preview,remove);
      list.append(item);
    }
  }
  function readMediaDuration(file,type){
    if(type.startsWith('image/'))return Promise.resolve(undefined);
    return new Promise(resolve=>{
      const tag=document.createElement(type.startsWith('video/')?'video':'audio');
      const url=URL.createObjectURL(file);
      let settled=false;
      const timer=setTimeout(()=>done(undefined),4000);
      const done=value=>{
        if(settled)return;
        settled=true;
        clearTimeout(timer);URL.revokeObjectURL(url);
        resolve(Number.isFinite(value)&&value>0?value:undefined);
      };
      tag.preload='metadata';
      tag.onloadedmetadata=()=>{
        if(tag.duration!==Infinity){done(tag.duration);return}
        // Browser-recorded WebM files can omit duration until the decoder seeks to the end.
        tag.ondurationchange=()=>{if(Number.isFinite(tag.duration))done(tag.duration)};
        tag.onseeked=()=>done(tag.duration);
        tag.currentTime=1e6;
      };
      tag.onerror=()=>done(undefined);
      tag.src=url;
    });
  }
  async function addReferences(fileList){
    const files=Array.from(fileList);
    if(!files.length)return 0;
    if(checkingFiles){refsNote('請等目前這批素材完成辨識。');return 0}
    checkingFiles=true;
    const add=$('pick-references');
    add.disabled=true;
    const type=kind, mode=videoMode();
    refsNote('正在辨識素材……');
    try{
      const accepted=files.slice(0,32);
      const detected=await Promise.all(accepted.map(async file=>{
        const mime=mediaType(file.name);
        return {name:file.name,size:file.size,type:mime,blob:file,
          duration:mime?await readMediaDuration(file,mime):undefined,uploadId:crypto.randomUUID().slice(0,8)};
      }));
      if(kind!==type||videoMode()!==mode)return 0;
      const errors=[];
      let count=0;
      for(const asset of detected){
        if(!asset.size||!asset.type){errors.push('不支援或空檔：'+asset.name);continue}
        if(stagedAssets.some(file=>file.name===asset.name&&file.size===asset.size&&file.type===asset.type)){
          errors.push('已加入：'+asset.name);continue;
        }
        const reason=checkReferences(kind,mode,textarea().value,[...activeFiles(),asset],{editing:true});
        if(reason){errors.push(reason);continue}
        stagedAssets.push(asset);count++;
      }
      if(files.length>32)errors.push('一次請拖入 32 個以下，實際上限依目前模式。');
      renderReferences();
      refsNote([count?'已辨識 '+count+' 個素材。':'',...new Set(errors)].filter(Boolean).join(' '),errors.length>0);
      return count;
    }finally{checkingFiles=false;add.disabled=false;$('job-files').value=''}
  }
  function insertPrompt(text,start=textarea().selectionStart,end=textarea().selectionEnd){
    const field=textarea();
    if(field.value.length-(end-start)+text.length>field.maxLength){refsNote('提示文字超過字數上限。',true);return false}
    field.focus();
    field.setRangeText(text,start,end,'end');
    persistDraft();renderReferences();
    closeReferenceMenu();
    return true;
  }
  function pendingMention(field){
    const cursor=field.selectionStart;
    if(cursor!==field.selectionEnd)return null;
    const match=field.value.slice(0,cursor).match(/@([a-zA-Z0-9\u3400-\u9fff]*(?:\(\d*)?)$/);
    if(!match)return null;
    const start=cursor-match[0].length;
    const suffix=field.value.slice(start);
    const existing=mentions(suffix).find(use=>suffix.startsWith(use.text));
    return {start,end:Math.max(cursor,start+(existing?.text.length||0)),query:match[1].toLowerCase()};
  }
  function matchesReference(file,query){
    const names=[file.tag.slice(1).toLowerCase(),file.kind+file.index,labels[file.kind]+file.index];
    if(file.kind==='image')names.push('picture'+file.index);
    return names.some(name=>name.startsWith(query));
  }
  function insertReference(file){
    const field=textarea();
    const pending=pendingMention(field);
    const replace=pending&&labelAssets(activeFiles()).some(asset=>matchesReference(asset,pending.query));
    const start=replace?pending.start:field.selectionStart;
    const end=replace?pending.end:field.selectionEnd;
    const next=field.value[end]||'';
    const space=/[\s，。！？、；：,.!?;:\)\]）】]/.test(next)?'':' ';
    insertPrompt(file.tag+space,start,end);
  }
  function closeReferenceMenu(){
    const menu=$('reference-menu');
    window.songyinMedia.clear(menu);
    menu.replaceChildren();
    menu.hidden=true;
    textarea().setAttribute('aria-expanded','false');
    textarea().removeAttribute('aria-activedescendant');
  }
  function selectMenuOption(menu,index,scroll=false){
    menuIndex=index;
    for(const [i,option] of Array.from(menu.children).entries()){
      option.setAttribute('aria-selected',String(i===index));
    }
    const current=menu.children[index];
    textarea().setAttribute('aria-activedescendant',current.id);
    if(scroll)current.scrollIntoView({block:'nearest'});
  }
  function renderReferenceMenu(){
    const field=textarea(),menu=$('reference-menu');
    const pending=pendingMention(field);
    const rows=pending&&usesReferenceTags(kind,videoMode())
      ?labelAssets(activeFiles()).filter(file=>matchesReference(file,pending.query)):[];
    closeReferenceMenu();
    if(!rows.length||document.activeElement!==field)return;
    menu.hidden=false;
    field.setAttribute('aria-expanded','true');
    menuIndex=0;
    rows.forEach((file,index)=>{
      const option=document.createElement('li');
      option.id='reference-option-'+index;
      option.setAttribute('role','option');
      option.tabIndex=-1;
      const text=document.createElement('span');
      const tag=document.createElement('strong');
      tag.textContent=file.tag;
      const name=document.createElement('small');
      name.textContent=file.name;
      text.append(tag,name);
      option.append(window.songyinMedia.thumbnail(file,option,{decorative:true}),text);
      option.addEventListener('mousedown',event=>event.preventDefault());
      option.addEventListener('click',()=>insertReference(file));
      menu.append(option);
    });
    selectMenuOption(menu,0);
  }
  $('pick-references').addEventListener('click',()=>$('job-files').click());
  $('job-files').addEventListener('change',event=>addReferences(event.target.files));
  const drop=$('reference-drop');
  for(const event of ['dragenter','dragover'])drop.addEventListener(event,e=>{
    if(!e.dataTransfer?.types.includes('Files'))return;
    e.preventDefault();e.dataTransfer.dropEffect='copy';drop.classList.add('dragging');
  });
  drop.addEventListener('dragleave',event=>{if(!drop.contains(event.relatedTarget))drop.classList.remove('dragging')});
  drop.addEventListener('drop',event=>{event.preventDefault();drop.classList.remove('dragging');if(event.dataTransfer?.files.length)addReferences(event.dataTransfer.files)});
  $('job-mode').addEventListener('change',()=>{
    refsNote('');
    renderReferences();
    renderReferenceMenu();
  });
  textarea().addEventListener('input',event=>{renderReferences();if(!event.isComposing)renderReferenceMenu()});
  textarea().addEventListener('compositionend',renderReferenceMenu);
  textarea().addEventListener('click',renderReferenceMenu);
  textarea().addEventListener('blur',event=>{
    if(!$('reference-menu').contains(event.relatedTarget))closeReferenceMenu();
  });
  textarea().addEventListener('keydown',event=>{
    const menu=$('reference-menu');
    if(menu.hidden||event.isComposing)return;
    if(event.key==='Escape'){event.preventDefault();closeReferenceMenu();return}
    const options=[...menu.children];
    if(['ArrowDown','ArrowUp'].includes(event.key)){
      event.preventDefault();
      const next=(menuIndex+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;
      selectMenuOption(menu,next,true);
    }else if(event.key==='Enter'||event.key==='Tab'){
      event.preventDefault();options[menuIndex]?.click();
    }
  });
  setupScriptLab(textarea(),insertPrompt);
  $('insert-reference-tags').addEventListener('click',()=>{
    const field=textarea(), found=mentions(field.value);
    const tags=labelAssets(activeFiles()).filter(file=>!found.some(use=>use.kind===file.kind&&use.index===file.index)).map(file=>file.tag);
    if(tags.length)insertPrompt((field.value?'\n\n':'')+'參考素材：'+tags.join('、'),field.value.length,field.value.length);
    else refsNote('所有已加入的素材都有標籤。');
  });
  $('insert-prompt-template').addEventListener('click',()=>{
    const field=textarea(), text=promptTemplate(kind,videoMode(),Number($('job-seconds').value)||5);
    insertPrompt((field.value?'\n\n':'')+text,field.value.length,field.value.length);
  });
  for(const [title,url] of sources){
    const item=document.createElement('li'), link=document.createElement('a');
    Object.assign(link,{textContent:title,href:url,target:'_blank',rel:'noopener noreferrer'});
    item.append(link);$('prompt-sources').append(item);
  }

  function persistDraft() {
    try {
      if(kind==='tts')voiceSeconds=$('job-seconds').value;
      localStorage.setItem(draftKey, JSON.stringify({kind, prompt: $('job-prompt').value, mode: $('job-mode').value, aspect: $('job-aspect').value, resolution: $('job-resolution').value, upscale: $('job-upscale').value, size: $('job-size').value, seconds: $('job-seconds').value,voiceSeconds,lora:loraSelect?.value}));
    } catch (_) { /* Queue persistence is checked independently through IndexedDB. */ }
  }

  function restoreDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(draftKey) || '{}');
      voiceSeconds=d.voiceSeconds||(d.kind==='tts'&&d.seconds)||'5';
      if(loraSelect)loraSelect.value=d.lora||'';
      for (const [key, id] of Object.entries({prompt:'job-prompt',mode:'job-mode',aspect:'job-aspect',resolution:'job-resolution',upscale:'job-upscale',size:'job-size',seconds:'job-seconds'})) {
        if (typeof d[key] === 'string') $(id).value = key==='prompt'?traditionalPrompt(d[key],d.kind):d[key];
      }
      updateKind(Object.keys(names).includes(d.kind) ? d.kind : 'video');
    } catch (_) { updateKind('video'); }
  }

  function renderJobs() {
    const list = $('job-list');
    list.replaceChildren();
    $('job-count').textContent = `${jobs.length} 項`;
    const exportButton=$('export-jobs');
    if(exportButton)exportButton.disabled=jobs.length===0;
    if (!jobs.length) {
      const p = document.createElement('p'); p.className='queue-empty'; p.textContent='尚無工作，先在上方加入一項創作。'; list.append(p); return;
    }
    for (const [index, job] of jobs.entries()) {
      const card=document.createElement('div');card.className='job-item';
      const content=document.createElement('div');
      const heading=document.createElement('strong');heading.textContent=`${String(index+1).padStart(2,'0')}　${names[job.type]}`;
      const prompt=document.createElement('p');const display=traditionalPrompt(job.prompt,job.type);prompt.textContent=display.length>100?display.slice(0,100)+'…':display;
      const info=document.createElement('small');info.textContent=[job.type!=='image'?`${job.seconds} 秒`:'',job.type!=='tts'?job.aspect:'',job.type==='video'&&job.upscale>1?'NVIDIA '+job.upscale+'×':'',job.lora?'色色增強（較慢）':'',job.files.length?`${job.files.length} 個素材`:'無素材'].filter(Boolean).join(' · ');
      const remove=document.createElement('button');remove.type='button';remove.textContent='移除';remove.setAttribute('aria-label',`移除第 ${index+1} 項工作`);remove.addEventListener('click',async()=>{try{await request('readwrite','delete',job.id);await refresh();note('已從這個瀏覽器移除工作。');}catch(e){note(`無法移除：${e.message}`,true);}});
      content.append(heading,prompt,info);card.append(content,remove);list.append(card);
    }
  }
  async function refresh(){jobs=(await request('readonly','getAll')).map(applyVideoSettings).sort((a,b)=>a.createdAt-b.createdAt);renderJobs();}

  document.querySelectorAll('.creator-tabs [data-kind]').forEach(el=>el.addEventListener('click',()=>{
    updateKind(el.dataset.kind);
    if(!editing)$('save-job').textContent='加入工作清單';
    note('');
  }));
  ['job-prompt','job-mode','job-aspect','job-resolution','job-upscale','job-size','job-seconds'].forEach(id=>$(id).addEventListener(id==='job-prompt'?'input':'change',persistDraft));
  loraSelect?.addEventListener('change',persistDraft);
  $('job-form').addEventListener('submit',async event=>{
    event.preventDefault();
    const prompt=$('job-prompt').value.trim();
    if(checkingFiles){note('請等素材辨識完成。',true);return}
    const seconds=Number($('job-seconds').value), mode=videoMode();
    const files=activeFiles();
    if(!prompt){note('請先輸入創作描述。',true);textarea().focus();return}
    if(kind!=='image'&&(!Number.isInteger(seconds)||seconds<2||seconds>15)){note('長度請輸入 2–15 秒。',true);return}
    if(kind==='video'&&mode==='frames'&&!frameSlots().first){note('請先加入首幀。',true);return}
    const issue=checkReferences(kind,mode,prompt,files);
    if(issue){note(issue,true);return}
    const id=editing?.id||'job_'+Date.now()+'_'+Math.random().toString(36).slice(2,8);
    const job=applyVideoSettings({id,createdAt:Date.now(),type:kind,prompt,mode,seconds,aspect:$('job-aspect').value,resolution:$('job-resolution').value,upscale:Number($('job-upscale').value),size:$('job-size').value,files});
    if(kind==='video'&&loraSelect?.value)job.lora=loraSelect.value;
    try{
      const updated=Boolean(editing?.id);
      await request('readwrite','put',job);
      editing=null;
      if(loraSelect)loraSelect.value='';
      stagedAssets=[];
      renderReferences();
      $('save-job').textContent='加入工作清單';
      await refresh();$('job-prompt').value='';$('job-files').value='';persistDraft();
      note(updated?'已更新這項工作的設定，接著按「同步工作至網站」。':'已加入工作清單，儲存在這個瀏覽器。');
    }catch(e){note(`未能儲存工作：${e.message}；請檢查瀏覽器儲存空間。`,true);}
  });

  const crcTable=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
  function crc32(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
  function header(size){const bytes=new Uint8Array(size);return [bytes,new DataView(bytes.buffer)];}
  function makeZip(entries){
    const encoder=new TextEncoder(),local=[],central=[];let offset=0,centralSize=0;
    for(const entry of entries){
      const name=encoder.encode(entry.name),data=entry.data,crc=crc32(data);
      const [lh,ld]=header(30+name.length);ld.setUint32(0,0x04034b50,true);ld.setUint16(4,20,true);ld.setUint16(6,0x0800,true);ld.setUint32(14,crc,true);ld.setUint32(18,data.length,true);ld.setUint32(22,data.length,true);ld.setUint16(26,name.length,true);lh.set(name,30);
      const [ch,cd]=header(46+name.length);cd.setUint32(0,0x02014b50,true);cd.setUint16(4,20,true);cd.setUint16(6,20,true);cd.setUint16(8,0x0800,true);cd.setUint32(16,crc,true);cd.setUint32(20,data.length,true);cd.setUint32(24,data.length,true);cd.setUint16(28,name.length,true);cd.setUint32(42,offset,true);ch.set(name,46);
      local.push(lh,data);central.push(ch);offset+=lh.length+data.length;centralSize+=ch.length;
    }
    const [end,ed]=header(22);ed.setUint32(0,0x06054b50,true);ed.setUint16(8,entries.length,true);ed.setUint16(10,entries.length,true);ed.setUint32(12,centralSize,true);ed.setUint32(16,offset,true);
    return new Blob([...local,...central,end],{type:'application/zip'});
  }

  async function buildPackage(){
    const encoder=new TextEncoder();const entries=[];const manifest={gpu:'L4',idle_minutes:15,model_source:'drive-first',stop_on_error:false,jobs:[]};
    try {const s=JSON.parse(localStorage.getItem(settingsKey)||'{}');if(['L4','G4','A100','H100'].includes(s.gpu))manifest.gpu=s.gpu;manifest.install_pictures=s.pictures===true;if(['drive-first','source-first'].includes(s.cache))manifest.model_source=s.cache;if([0,5,15,30,60].includes(Number(s.idle)))manifest.idle_minutes=Number(s.idle);} catch (_) {}
    for(const job of jobs){
      const paths=[];
      for(const [i,f] of job.files.entries()){
        const match=f.name.match(/\.([a-z0-9]{1,8})$/i);const ext=match?'.'+match[1].toLowerCase():'';const path=`inputs/${job.id}_${i+1}${ext}`;
        const source=f.blob||await fetch('/api/assets/'+encodeURIComponent(f.id)).then(response=>{if(!response.ok)throw new Error('無法取回參考素材：'+f.name);return response.blob()});
        const bytes=new Uint8Array(await source.arrayBuffer());entries.push({name:path,data:bytes});paths.push(path);
      }
      const item={id:job.id,type:job.type,prompt:submissionPrompt(job.type,job.mode,job.prompt)};
      if(job.type==='video'){
        Object.assign(item,{mode:job.mode,seconds:job.seconds,aspect:job.aspect,resolution:job.resolution,upscale:job.upscale||1,intensity:'off',fast:true});
        if(job.lora)item.lora=job.lora;
        if(job.mode==='frames'){item.first=paths[0];if(paths[1])item.last=paths[1];}else if(paths.length){item.inputs=paths;}
      }else if(job.type==='image'){
        Object.assign(item,{aspect:job.aspect,size:job.size});if(paths.length)item.inputs=paths;
      }else{item.seconds=job.seconds;if(paths.length)item.voices=paths;}
      manifest.jobs.push(item);
    }
    entries.unshift({name:'manifest.json',data:encoder.encode(JSON.stringify(manifest,null,2))});
    return makeZip(entries);
  }

  $('export-jobs')?.addEventListener('click',async()=>{
    if(!jobs.length)return;const button=$('export-jobs');button.disabled=true;note('正在準備工作包……');
    try{const blob=await buildPackage();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='Colab-H3-工作包.zip';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);note('工作包已準備下載；尚未送出至 Colab。');}
    catch(e){note(`無法產生工作包：${e.message}`,true);}finally{button.disabled=jobs.length===0;}
  });

  window.songyinJobs={
    get:()=>jobs,
    addPlaybackFrame(file,slot){
      if(!file?.size||!['first','last'].includes(slot))throw new Error('目前畫面還無法擷取。');
      if(checkingFiles)throw new Error('請等目前素材完成辨識。');
      const sameMode=kind==='video'&&videoMode()==='frames';
      $('job-mode').value='frames';
      updateKind('video');
      if(!sameMode){
        // Other reference assets stay in the draft and become available again in reference mode.
        stagedAssets=stagedAssets.map(asset=>asset.frameSlot==='reference'?asset:{...asset,frameSlot:'reference'});
      }
      const slots=frameSlots();
      const current=slots[slot];
      const otherSlot=slot==='first'?'last':'first';
      if(slots[otherSlot])slots[otherSlot].frameSlot=otherSlot;
      if(current)stagedAssets.splice(stagedAssets.indexOf(current),1);
      stagedAssets.push({name:file.name,size:file.size,type:file.type,blob:file,frameSlot:slot,uploadId:crypto.randomUUID().slice(0,8)});
      renderReferences();
      refsNote(slot==='first'?'已把播放畫面設為首幀。':'已把播放畫面設為尾幀。');
    },
    async addPlaybackReference(file){
      if(checkingFiles)throw new Error('請等目前素材完成辨識。');
      $('job-mode').value='ref';
      updateKind('video');
      if(!await addReferences([file])){
        throw new Error($('reference-status').textContent||'目前無法加入這個素材。');
      }
    },
    loadCloud(job,state){
      job=applyVideoSettings(job);
      updateKind(job.type);
      editing={id:state==='draft'?job.id:null};
      stagedAssets=(job.files||[]).map(file=>({...file,size:file.bytes}));
      $('save-job').textContent=editing.id?'更新工作設定':'以此設定加入新工作';
      $('job-prompt').value=traditionalPrompt(job.prompt,job.type);
      $('job-upscale').value=String(job.upscale||1);
      if(loraSelect)loraSelect.value=job.lora||'';
      for(const [key,id] of Object.entries({mode:'job-mode',aspect:'job-aspect',resolution:'job-resolution',upscale:'job-upscale',size:'job-size',seconds:'job-seconds'})){
        if(job[key]!==undefined)$(id).value=String(job[key]);
      }
      persistDraft();renderReferences();
      note(stagedAssets.length?'已載入設定與原參考素材。':'已載入工作文字與設定。');
    }
  };
  restoreDraft();
  openDatabase().then(async value=>{db=value;await refresh();}).catch(e=>{note(`無法使用瀏覽器工作清單：${e.message}`,true);$('job-form').querySelector('button[type=submit]').disabled=true;});
})();
