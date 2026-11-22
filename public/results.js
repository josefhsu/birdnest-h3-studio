(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const kinds={video:'影片',image:'圖片',tts:'配音'};
  const creator=document.body.dataset.workspace==='creator';
  const stages=[
    ['uploading','傳送素材'],['starting','準備工作'],['install','設定 GPU 環境'],
    ['models','載入模型'],['engine','啟動引擎'],['generating','生成'],['upscaling','影片放大'],['archiving','收錄成品']
  ];
  const upscaleStages=stages.filter(([key])=>!['models','engine','generating'].includes(key));
  const stepNames={
    queued:'等待生成',prompt_language:'轉換提示語言',prepare:'準備推論',low:'低解析度採樣',high:'高解析度採樣',
    sample:'採樣',sampling:'推論中',decode:'解碼影音',join:'接合片段',upscaling:'NVIDIA RTX VSR 放大',export:'匯出與保存',
  };
  const archiveCards=new Map();
  const archiveDialog=$('result-dialog');
  let openResultId=null;
  archiveDialog.addEventListener('close',()=>{
    if(archiveDialog.open)return;
    const content=$('result-dialog-content');
    window.songyinMedia.clear(content);
    window.songyinVideoEditor.clear(content);
    content.replaceChildren();
    archiveCards.get(openResultId)?.node.querySelector('button')?.focus();
    openResultId=null;
  });
  $('result-dialog-close').addEventListener('click',()=>archiveDialog.close());
  const el=(tag,content,cls)=>{
    const item=document.createElement(tag);
    if(content!==undefined)item.textContent=content;
    if(cls)item.className=cls;
    return item;
  };
  const formatElapsed=seconds=>{
    if(!Number.isFinite(seconds)||seconds<0)return '—';
    const count=Math.round(seconds);
    return count<60?count+' 秒':Math.floor(count/60)+' 分 '+String(count%60).padStart(2,'0')+' 秒';
  };
  const duration=seconds=>Number.isFinite(seconds)?Number(seconds.toFixed(2))+' 秒':'';
  const decimal=(value,places=2)=>Number.isFinite(value)?Number(value.toFixed(places)):null;
  const megabytes=value=>(value/(1024*1024)).toFixed(1)+' MB';
  function progressBar(value,label){
    const bar=el('progress');
    bar.max=100;
    if(Number.isFinite(value))bar.value=Math.min(100,Math.max(0,value));
    bar.setAttribute('aria-label',label);
    return bar;
  }
  function renderProgress(runtime){
    const box=$('generation-progress');
    const stage=runtime?.stage||(runtime?.phase==='running'?'starting':runtime?.phase);
    box.hidden=!runtime||!['uploading','running'].includes(runtime.phase)&&!['finished','failed'].includes(stage);
    if(box.hidden)return;
    const steps=runtime.operation==='upscale'?upscaleStages:stages;
    const currentIndex=steps.findIndex(item=>item[0]===stage);
    const list=$('generation-stages');
    list.replaceChildren(...steps.map(([key,name],index)=>{
      const li=el('li',name);
      if(key===stage){li.className='now';li.setAttribute('aria-current','step')}
      else if(index<currentIndex||stage==='finished')li.className='passed';
      return li;
    }));
    const location=$('generation-detail');
    location.replaceChildren();
    const progress=runtime.progress;
    if(progress&&progress.stage===stage&&progress.total>0){
      const description=progress.unit==='bytes'
        ?megabytes(progress.completed)+' / '+megabytes(progress.total)
        :progress.completed+' / '+progress.total+' 個模型';
      location.append(progressBar(progress.completed/progress.total*100,description),el('span',description));
      if(progress.detail)location.append(el('small',progress.detail));
    }else if(['uploading','starting','install','engine','upscaling','archiving','models'].includes(stage)){
      location.append(progressBar(null,'進行中'));
    }
    const jobs=$('generation-items');
    jobs.replaceChildren();
    for(const [index,job] of (runtime.jobProgress||[]).entries()){
      const progress=job.progress;
      const name=job.status==='done'?(runtime.operation==='upscale'?'已放大':'已生成'):job.status==='error'?'未完成':
        job.status==='cancelled'?'已移出排隊':
        stepNames[progress?.stage]||(job.status==='running'?'推論準備中':'等待生成');
      const item=el('div',undefined,'gen-item');
      const percent=decimal(progress?.percent,0);
      item.append(el('strong','工作 '+(index+1)+' · '+name));
      if(job.status==='running'){
        const measured=progress?.live===true&&percent!==null;
        item.append(progressBar(measured?percent:null,'工作 '+(index+1)+' 生成進度'));
        const eta=measured&&Number.isFinite(progress?.eta)?' · 預估剩餘 '+formatElapsed(progress.eta):'';
        const elapsed=job.started?formatElapsed(Date.now()/1000-job.started):'';
        item.append(el('small',(measured?'估計 '+percent+'%'+eta:'等待引擎進度')+(elapsed?' · 已用 '+elapsed:'')));
      }
      jobs.append(item);
    }
  }
  function referenceFile(file){
    const base='/api/assets/'+encodeURIComponent(file.id);
    const card=el('li',undefined,'ref-card');
    card.append(window.songyinMedia.thumbnail(file,card));
    const link=el('a',file.name);
    Object.assign(link,{href:base,download:file.name});
    const meta=el('div',undefined,'ref-card-meta');
    meta.append(link,el('small',megabytes(file.bytes)));
    card.append(meta);
    return card;
  }
  function readAsMedia(file,kind){
    const url=URL.createObjectURL(file);
    const isImage=kind==='image';
    const element=isImage?el('img'):el(kind==='video'?'video':'audio');
    element.muted=true;
    element.preload='auto';
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>failed(),12000);
      function settle(value,error){
        clearTimeout(timeout);
        URL.revokeObjectURL(url);
        if(error)reject(new Error('這個檔案無法預覽。請選擇對應的作品原檔。'));
        else resolve(value);
      }
      function failed(){settle(null,true)}
      function done(){
        const metadata=isImage
          ?{width:element.naturalWidth,height:element.naturalHeight}
          :{duration:element.duration,width:element.videoWidth,height:element.videoHeight};
        if(kind!=='video'){settle({metadata});return}
        const canvas=el('canvas');
        const scale=Math.min(1,640/(element.videoWidth||640));
        canvas.width=Math.round(element.videoWidth*scale);
        canvas.height=Math.round(element.videoHeight*scale);
        try{
          canvas.getContext('2d').drawImage(element,0,0,canvas.width,canvas.height);
          canvas.toBlob(poster=>settle({metadata,poster}),'image/jpeg',.84);
        }catch{settle({metadata})}
      }
      element.addEventListener('error',failed,{once:true});
      element.addEventListener(isImage?'load':kind==='video'?'loadeddata':'loadedmetadata',done,{once:true});
      element.src=url;
    });
  }
  async function mp4Tracks(file,metadata){
    // MP4 stores media rates and codec declarations in its movie header.
    if(!/\.mp4$/i.test(file.name)||file.size>25*1024*1024)return;
    const bytes=await file.arrayBuffer();
    const view=new DataView(bytes);
    const str=(at,n)=>String.fromCharCode(...new Uint8Array(bytes,at,n));
    function boxes(low,high){
      const out=[];
      while(low+8<=high){
        const size=view.getUint32(low),name=str(low+4,4);
        if(size<8||low+size>high)break;
        out.push({name,start:low+8,end:low+size});
        low+=size;
      }
      return out;
    }
    const children=node=>node?boxes(node.start,node.end):[];
    const find=(node,name)=>children(node).find(box=>box.name===name);
    const movie=boxes(0,view.byteLength).find(box=>box.name==='moov');
    for(const track of children(movie).filter(node=>node.name==='trak')){
      const mdia=find(track,'mdia');
      const mdhd=find(mdia,'mdhd'), handler=find(mdia,'hdlr');
      const table=find(find(mdia,'minf'),'stbl');
      const desc=find(table,'stsd');
      if(!mdhd||!handler||!desc||desc.end-desc.start<16||handler.end-handler.start<12)continue;
      const timescale=view.getUint32(mdhd.start+(view.getUint8(mdhd.start)===1?20:12));
      const kind=str(handler.start+8,4);
      const codec=str(desc.start+12,4);
      if(kind==='soun'&&desc.end-desc.start>=36){
        metadata.sampleRate=timescale;
        metadata.channels=view.getUint16(desc.start+32);
        metadata.audioCodec=codec==='mp4a'?'aac':codec.trim();
      }
      if(kind==='vide'){
        metadata.videoCodec=codec==='avc1'?'h264':codec==='hvc1'?'hevc':codec.trim();
        const stamps=find(table,'stts');
        if(stamps&&stamps.end-stamps.start>=8){
          let samples=0,ticks=0;
          for(let offset=stamps.start+8;offset+8<=stamps.end;offset+=8){
            const count=view.getUint32(offset);samples+=count;ticks+=count*view.getUint32(offset+4);
          }
          if(ticks>0)metadata.fps=samples*timescale/ticks;
        }
      }
    }
  }
  async function uploadExisting(file,job,url,readout,onAttached){
    readout.textContent='正在讀取作品原檔……';
    if(file.size!==job.result.bytes)throw new Error('檔案大小與這項作品不同，請選擇原始下載檔。');
    const {metadata,poster}=await readAsMedia(file,job.kind);
    try{await mp4Tracks(file,metadata)}catch{ /* Browser measurements still apply. */ }
    readout.textContent='正在收錄到私人鳥巢H3大師……';
    const upload=async (target,body,extra={})=>{
      const response=await fetch(target,{method:'PUT',headers:{'x-result-size':String(body.size),...extra},body});
      if(!response.ok){const problem=await response.json();throw new Error(problem.error||'收錄失敗')}
    };
    await upload(url,file,{'x-result-media':JSON.stringify(metadata)});
    if(poster)try{await upload(url+'?poster=1',poster)}catch{ /* The original is available without its poster. */ }
    await onAttached();
  }
  const resultUrl=job=>'/api/results/'+encodeURIComponent(job.id);
  const resultDate=job=>new Date(job.result.finished?job.result.finished*1000:job.updated_at);
  function buildTile(job,onOpen){
    const result=job.result, media=result.media||{};
    const type=kinds[job.kind]||'作品';
    const stamp=resultDate(job);
    const title=stamp.toLocaleString('zh-TW');
    const tile=el('article',undefined,'gallery-card');
    const button=el('button',undefined,'gallery-thumb');
    button.type='button';
    button.setAttribute('aria-haspopup','dialog');
    button.setAttribute('aria-label','開啟'+type+'作品，'+title);
    button.addEventListener('click',onOpen);
    const url=resultUrl(job);
    const source=result.archived&&(result.hasPoster?url+'?poster=1':job.kind==='image'?url:null);
    const placeholder=el('span',{video:'▷',image:'▧',tts:'≋'}[job.kind]||'◇','gallery-placeholder');
    placeholder.setAttribute('aria-hidden','true');
    button.append(placeholder);
    if(source){
      const image=el('img');
      Object.assign(image,{alt:'',loading:'lazy',decoding:'async'});
      image.addEventListener('error',()=>image.remove(),{once:true});
      image.src=source;
      button.append(image);
    }
    if(source&&job.kind==='video'){
      const playBadge=el('span','▶','gallery-play');
      playBadge.setAttribute('aria-hidden','true');
      button.append(playBadge);
    }
    const length=duration(media.duration);
    if(length&&job.kind!=='image')button.append(el('span',length,'gallery-length'));
    const summary=el('div',undefined,'gallery-caption');
    const caption=el('div',undefined,'gallery-caption-line');
    caption.append(el('strong',job.manifest?.operation==='upscale'?job.manifest.upscale+'× 放大':type));
    if(!result.archived)caption.append(el('small','待收錄'));
    else if(media.width&&media.height)caption.append(el('small',media.width+' × '+media.height));
    else if(media.sampleRate)caption.append(el('small',decimal(media.sampleRate/1000)+' kHz'));
    const date=el('time',title);
    if(Number.isFinite(stamp.getTime()))date.dateTime=stamp.toISOString();
    summary.append(caption,date);
    tile.append(button,summary);
    return tile;
  }
  function showResult(job,onImport,onAttached,onUpscale){
    archiveDialog.querySelector('h3').textContent=kinds[job.kind]?kinds[job.kind]+'作品':'作品';
    const content=$('result-dialog-content');
    window.songyinMedia.clear(content);
    window.songyinVideoEditor.clear(content);
    content.replaceChildren(buildResultView(job,onImport,onAttached,onUpscale));
  }
  function upscaleControls(job,onUpscale){
    const group=el('div',undefined,'result-upscale');
    const actions=el('div',undefined,'result-upscale-actions');
    const begin=el('button',creator?'2× 放大':'放大影片','subtle-button');
    begin.type='button';
    let factor=2;
    let requestId;
    let select;
    if(!creator){
      select=el('select');
      select.setAttribute('aria-label','影片放大倍率');
      for(const value of [1.5,2,3,4]){
        const option=el('option',value+'×');
        option.value=String(value);
        select.append(option);
      }
      select.value=String(factor);
      actions.append(select);
    }
    actions.append(begin);
    const confirmation=el('div',undefined,'result-upscale-confirm');
    confirmation.hidden=true;
    const summary=el('p');
    const choices=el('div',undefined,'result-upscale-actions');
    const cancel=el('button','取消','subtle-button');
    const send=el('button','確認送出','deploy');
    const status=el('p',undefined,'result-upscale-status');
    status.setAttribute('role','status');
    cancel.type=send.type='button';
    choices.append(cancel,send);
    confirmation.append(summary,choices);
    group.append(actions,confirmation,status);
    const media=job.result.media||{};
    const overLimit=media.height>media.width
      ? media.width>=2160||media.height>=3840 : media.width>=3840||media.height>=2160;
    if(overLimit){
      begin.disabled=true;
      if(select)select.disabled=true;
      status.textContent='這支影片已達 4K 尺寸上限。';
      return group;
    }
    function closeConfirmation(){
      confirmation.hidden=true;
      begin.disabled=false;
      if(select)select.disabled=false;
      begin.focus({preventScroll:true});
    }
    begin.addEventListener('click',()=>{
      factor=select?Number(select.value):2;
      requestId=crypto.randomUUID();
      status.textContent='';
      summary.textContent='使用 NVIDIA '+factor+'× 放大，另存一支影片。最大輸出為 4K。';
      confirmation.hidden=false;
      begin.disabled=true;
      if(select)select.disabled=true;
      cancel.focus({preventScroll:true});
    });
    cancel.addEventListener('click',()=>{
      status.textContent='';
      closeConfirmation();
    });
    send.addEventListener('click',async()=>{
      send.disabled=cancel.disabled=true;
      status.textContent='正在送出放大工作…';
      try{
        await onUpscale(job.id,factor,requestId);
        status.textContent='已送出，可在雲端工作紀錄查看進度。';
        closeConfirmation();
      }catch(error){
        status.textContent=error.message;
      }finally{
        send.disabled=cancel.disabled=false;
      }
    });
    return group;
  }
  function buildResultView(job,onImport,onAttached,onUpscale){
    const result=job.result, manifest=job.manifest||{}, media=result.media||{};
    const type=kinds[job.kind]||'作品';
    const url=resultUrl(job);
    const card=el('div',undefined,'result-view');
    card.append(el('p',resultDate(job).toLocaleString('zh-TW'),'result-date'));
    if(result.archived){
      const display=el('div',undefined,'result-media');
      let mediaElement=null;
      if(job.kind==='image'){
        const image=el('img');
        Object.assign(image,{src:url,alt:'生成圖片'});
        display.append(image);
      }else{
        const player=el(job.kind==='video'?'video':'audio');
        Object.assign(player,{src:url,controls:true,preload:'metadata',playsInline:true});
        if(result.hasPoster&&job.kind==='video')player.poster=url+'?poster=1';
        player.setAttribute('aria-label',type+'播放');
        display.append(player);
        mediaElement=player;
      }
      card.append(display);
      card.append(window.songyinVideoEditor.controls(job,mediaElement,url));
      if(job.kind==='video')card.append(upscaleControls(job,onUpscale));
    }else if(creator){
      card.append(el('p','這件作品的站內預覽尚未就緒。'));
    }else{
      const message=el('p',result.archiveError||'既有作品尚未收錄到鳥巢H3大師。');
      const button=el('button','收錄舊作品','secondary');
      button.type='button';
      button.addEventListener('click',()=>onImport(job.id));
      const localLabel=el('label','從裝置收錄原檔','result-upload');
      const local=el('input');
      local.type='file';
      local.accept=job.kind==='video'?'video/*':job.kind==='image'?'image/*':'audio/*';
      const readout=el('p');
      readout.setAttribute('role','status');
      local.addEventListener('change',async()=>{
        const file=local.files?.[0];
        if(!file)return;
        local.disabled=true;
        button.disabled=true;
        try{await uploadExisting(file,job,url,readout,onAttached)}
        catch(error){readout.textContent=error.message}
        finally{local.disabled=false;button.disabled=false;local.value=''}
      });
      localLabel.append(local);
      card.append(message,button,localLabel,readout);
    }
    const requested=result.requested_seconds??manifest.seconds;
    const values=[
      [manifest.operation==='upscale'?'放大耗時':'生成耗時',formatElapsed(result.seconds_used)],
      ['LoRA',manifest.lora==='extreme-realism-v3'?'Extreme Realism V3':''],
      ['要求長度',duration(requested)],
      ['實際長度',duration(media.duration)],
      ['畫面規格',media.width&&media.height?media.width+' × '+media.height+(media.fps?' · '+decimal(media.fps)+' fps':''):''],
      ['音訊規格',media.sampleRate?[decimal(media.sampleRate/1000)+' kHz',media.channels===2?'立體聲':media.channels===1?'單聲道':media.channels+' 聲道',media.audioCodec?.toUpperCase()].filter(Boolean).join(' · '):media.videoCodec?'無音軌':''],
      ['格式',[media.format,media.videoCodec?.toUpperCase(),result.bytes?megabytes(result.bytes):''].filter(Boolean).join(' · ')]
    ];
    const upscale=result.upscale;
    if(upscale?.status==='done'){
      values.push(['NVIDIA 放大',upscale.requested+'×'+(upscale.capped?' · 受 4K 上限限制':'')+' · '+formatElapsed(upscale.seconds)]);
    }
    const specs=el('dl',undefined,'result-specs');
    for(const [label,value] of values)if(value)specs.append(el('dt',label),el('dd',value));
    card.append(specs);
    if(upscale?.status==='failed')card.append(el('p','NVIDIA 放大未完成，已保留原始影片。執行紀錄中可查看原因。','result-warning'));
    if(upscale?.status==='at_limit')card.append(el('p','影片已達 4K 尺寸上限，已保留原始影片。','result-warning'));
    const tolerance=1.25/(media.fps||24);
    if(job.kind==='video'&&Number.isFinite(media.duration)&&Number.isFinite(requested)&&Math.abs(media.duration-requested)>tolerance){
      card.append(el('p','這支影片的實際長度與要求不同。','result-warning'));
    }
    const details=el('details');
    details.append(el('summary','提示與參考素材'),el('h4','原始提示'),el('pre',manifest.prompt||job.prompt));
    if(result.final_prompt&&result.final_prompt!==(manifest.prompt||job.prompt)){
      const modelPrompt=el('details');
      modelPrompt.append(el('summary','查看送給 H3 的提示'),el('pre',result.final_prompt));
      details.append(modelPrompt);
    }
    const references=manifest.files||[];
    details.append(el('h4','參考素材（'+references.length+'）'));
    if(references.length){
      const list=el('ul',undefined,'result-refs');
      for(const file of references)list.append(referenceFile(file));
      details.append(list);
    }else details.append(el('p','這項工作未附參考檔案。'));
    card.append(details);
    if(result.archived){
      const download=el('a','下載原檔','subtle-button');
      Object.assign(download,{href:url+'?download=1',download:result.file});
      card.append(download);
    }
    return card;
  }
  function renderArchive(jobs,onImport,onAttached,onUpscale){
    const results=jobs.filter(job=>job.state==='done'&&job.result?.file)
      .sort((a,b)=>(b.result.finished||b.created_at/1000)-(a.result.finished||a.created_at/1000));
    const host=$('saved-results');
    $('saved-count').textContent=results.length+' 件作品';
    const ids=new Set(results.map(job=>job.id));
    for(const [id,record] of archiveCards)if(!ids.has(id)){
      if(openResultId===id&&archiveDialog.open)archiveDialog.close();
      record.node.remove();
      archiveCards.delete(id);
    }
    $('results-empty').hidden=Boolean(results.length);
    for(const [index,job] of results.entries()){
      const signature=JSON.stringify([job.kind,job.result,job.manifest,job.prompt]);
      let record=archiveCards.get(job.id);
      if(record?.signature!==signature){
        const node=buildTile(job,()=>{
          openResultId=job.id;
          showResult(job,onImport,onAttached,onUpscale);
          archiveDialog.showModal();
        });
        if(record)record.node.replaceWith(node);
        record={node,signature};
        archiveCards.set(job.id,record);
        if(openResultId===job.id&&archiveDialog.open){
          const keepFocus=$('result-dialog-content').contains(document.activeElement);
          showResult(job,onImport,onAttached,onUpscale);
          if(keepFocus)$('result-dialog-close').focus();
        }
      }
      if(host.children[index]!==record.node)host.insertBefore(record.node,host.children[index]||null);
    }
  }
  window.songyinResults={renderArchive,renderProgress};
})();
