(() => {
  'use strict';
  const editors=new WeakMap();
  function el(tag,text,className){
    const node=document.createElement(tag);
    if(text)node.textContent=text;
    if(className)node.className=className;
    return node;
  }
  function button(text){
    const node=el('button',text,'subtle-button');
    node.type='button';
    return node;
  }
  function canvasFor(width,height){
    const canvas=el('canvas');
    canvas.width=width;
    canvas.height=height;
    return canvas;
  }
  function still(video){
    if(video.readyState<2||!video.videoWidth)throw new Error('影片畫面載入後即可擷取。');
    const canvas=canvasFor(video.videoWidth,video.videoHeight);
    canvas.getContext('2d').drawImage(video,0,0);
    return canvas;
  }
  function png(canvas){
    return new Promise((resolve,reject)=>canvas.toBlob(blob=>{
      if(blob)resolve(blob);
      else reject(new Error('截圖失敗，請再試一次。'));
    },'image/png'));
  }
  function fileStem(filename){
    return (filename||'作品').replace(/\.[^.]+$/,'');
  }
  function withTime(element,event,signal,ready=()=>false){
    if(signal.aborted)return Promise.reject(signal.reason);
    if(ready())return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const stop=new AbortController();
      const timeout=setTimeout(()=>finish(new Error('影片讀取逾時。')),12000);
      function finish(error){
        clearTimeout(timeout);
        stop.abort();
        if(error)reject(error);
        else resolve();
      }
      element.addEventListener(event,()=>finish(),{signal:stop.signal,once:true});
      element.addEventListener('error',()=>finish(new Error('無法讀取這支影片。')),{signal:stop.signal,once:true});
      signal.addEventListener('abort',()=>finish(signal.reason),{signal:stop.signal,once:true});
    });
  }
  function selectableFrame(video){
    const canvas=still(video);
    const stage=el('div',undefined,'frame-select');
    stage.tabIndex=0;
    stage.setAttribute('aria-label','裁切畫面選區。方向鍵移動，Shift 加方向鍵調整大小。');
    const frame=el('div',undefined,'frame-select-area');
    stage.append(canvas,frame);
    const width=canvas.width,height=canvas.height;
    let area={x:0,y:0,w:width,h:height};
    let start=null,pointer=null;
    const clamp=(value,min,max)=>Math.min(Math.max(value,min),max);
    function paint(){
      frame.style.left=area.x/width*100+'%';
      frame.style.top=area.y/height*100+'%';
      frame.style.width=area.w/width*100+'%';
      frame.style.height=area.h/height*100+'%';
    }
    function coordinates(event){
      const r=stage.getBoundingClientRect();
      return {x:clamp(Math.round((event.clientX-r.left)*width/r.width),0,width),
        y:clamp(Math.round((event.clientY-r.top)*height/r.height),0,height)};
    }
    stage.addEventListener('pointerdown',event=>{
      if(!event.isPrimary||event.button!==0)return;
      stage.focus({preventScroll:true});
      stage.setPointerCapture(event.pointerId);
      pointer=event.pointerId;
      start=coordinates(event);
    });
    stage.addEventListener('pointermove',event=>{
      if(!start||pointer!==event.pointerId)return;
      const end=coordinates(event);
      const x=Math.min(start.x,end.x,width-1),y=Math.min(start.y,end.y,height-1);
      area={x,y,w:Math.max(1,Math.abs(end.x-start.x)),h:Math.max(1,Math.abs(end.y-start.y))};
      paint();
    });
    for(const name of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(name,()=>{
      pointer=null;
      start=null;
    });
    stage.addEventListener('keydown',event=>{
      const direction={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
      if(!direction)return;
      event.preventDefault();
      const [dx,dy]=direction.map(value=>value*8);
      if(event.shiftKey){
        area.w=clamp(area.w+dx,1,width-area.x);
        area.h=clamp(area.h+dy,1,height-area.y);
      }else{
        area.x=clamp(area.x+dx,0,width-area.w);
        area.y=clamp(area.y+dy,0,height-area.h);
      }
      paint();
    });
    paint();
    return {stage,area:()=>({...area}),screenshot:()=>{
      const {x,y,w,h}=area;
      const output=canvasFor(w,h);
      output.getContext('2d').drawImage(canvas,x,y,w,h,0,0,w,h);
      return png(output);
    }};
  }
  async function addWebmDuration(blob,seconds){
    const header=new Uint8Array(await blob.slice(0,65536).arrayBuffer());
    function vint(offset,isId=false){
      let flag=128,length=1;
      while(length<=8&&!(header[offset]&flag)){flag>>=1;length++}
      if(length>8||offset+length>header.length)throw new Error('Invalid EBML header');
      let value=BigInt(isId?header[offset]:header[offset]&(~flag));
      for(let i=1;i<length;i++)value=(value<<8n)|BigInt(header[offset+i]);
      return {length,value,unknown:!isId&&value===(1n<<BigInt(length*7))-1n};
    }
    function element(offset){
      const id=vint(offset,true), sizeAt=offset+id.length, size=vint(sizeAt);
      const data=sizeAt+size.length;
      return {id:Number(id.value),offset,sizeAt,data,size,end:data+Number(size.value)};
    }
    try{
      const ebml=element(0), segment=element(ebml.end);
      // MediaRecorder usually emits an open Segment without a seek table.
      if(ebml.id!==0x1a45dfa3||segment.id!==0x18538067||!segment.size.unknown)return blob;
      let info=element(segment.data);
      while(info.id===0xec)info=element(info.end);
      if(info.id!==0x1549a966||info.end>header.length)return blob;
      let scale=1e6;
      for(let offset=info.data;offset<info.end;){
        const child=element(offset);
        if(child.size.unknown||child.end>info.end)return blob;
        if(child.id===0x4489)return blob;
        if(child.id===0x2ad7b1){
          scale=0;
          for(const byte of header.subarray(child.data,child.end))scale=scale*256+byte;
        }
        offset=child.end;
      }
      if(!scale)return blob;
      const duration=Uint8Array.of(0x44,0x89,0x88,0,0,0,0,0,0,0,0);
      new DataView(duration.buffer).setFloat64(3,seconds*1e9/scale);
      const newSize=info.end-info.data+duration.length;
      const length=newSize<127?1:2;
      if(newSize>=16383)return blob;
      const size=length===1?Uint8Array.of(0x80|newSize):Uint8Array.of(0x40|(newSize>>8),newSize&255);
      return new Blob([blob.slice(0,info.sizeAt),size,blob.slice(info.data,info.end),duration,blob.slice(info.end)],{type:blob.type});
    }catch{return blob}
  }
  async function recordClip(source,range,area,fps,signal,progress){
    if(typeof MediaRecorder!=='function'||!HTMLCanvasElement.prototype.captureStream){
      throw new Error('此瀏覽器不支援影片裁剪匯出。');
    }
    const Audio=window.AudioContext||window.webkitAudioContext;
    if(!Audio)throw new Error('此瀏覽器不支援影片音軌匯出。');
    if(document.hidden)throw new Error('請在目前分頁匯出影片。');
    const audio=new Audio();
    const video=el('video');
    video.playsInline=true;
    video.preload='auto';
    let stream,recorder,tick,timer;
    const listeners=new AbortController();
    try{
      await audio.resume();
      const destination=audio.createMediaStreamDestination();
      audio.createMediaElementSource(video).connect(destination);
      video.src=source;
      await withTime(video,'loadeddata',signal,()=>video.readyState>=2);
      if(Math.abs(video.currentTime-range.start)>.001){
        const seek=withTime(video,'seeked',signal);
        video.currentTime=range.start;
        await seek;
      }
      const cut=area||{x:0,y:0,w:video.videoWidth,h:video.videoHeight};
      const canvas=canvasFor(Math.max(2,cut.w-cut.w%2),Math.max(2,cut.h-cut.h%2));
      const ctx=canvas.getContext('2d');
      const draw=()=>ctx.drawImage(video,cut.x,cut.y,cut.w,cut.h,0,0,canvas.width,canvas.height);
      draw();
      stream=canvas.captureStream(Math.min(60,Math.max(12,fps||30)));
      for(const track of destination.stream.getAudioTracks())stream.addTrack(track);
      const mime=['video/mp4;codecs=avc1.42001f,mp4a.40.2','video/webm;codecs=vp8,opus','video/webm','video/mp4']
        .find(type=>MediaRecorder.isTypeSupported(type));
      recorder=new MediaRecorder(stream,mime?{mimeType:mime}:{});
      const chunks=[];
      recorder.addEventListener('dataavailable',event=>{if(event.data.size)chunks.push(event.data)});
      let done,fail;
      const recorded=new Promise((resolve,reject)=>{done=resolve;fail=reject});
      // Register the rejection before starting playback, which may itself fail or be cancelled.
      recorded.catch(()=>{});
      video.addEventListener('error',()=>fail(new Error('裁剪時無法讀取影片。')),{once:true});
      recorder.addEventListener('error',()=>fail(new Error('瀏覽器無法完成影片編碼。')),{once:true});
      recorder.addEventListener('stop',()=>{
        if(signal.aborted){fail(signal.reason);return}
        if(!chunks.length){fail(new Error('裁剪未產生檔案。'));return}
        done(new Blob(chunks,{type:recorder.mimeType||mime||'video/webm'}));
      },{once:true});
      function stop(){
        video.pause();
        if(recorder.state!=='inactive')recorder.stop();
      }
      signal.addEventListener('abort',()=>{fail(signal.reason);stop()},{once:true,signal:listeners.signal});
      document.addEventListener('visibilitychange',()=>{
        if(document.hidden){
          fail(new Error('請保持此分頁在前景，再匯出影片。'));
          stop();
        }
      },{signal:listeners.signal});
      video.addEventListener('ended',stop,{once:true});
      const animate=()=>{
        if(video.currentTime>=range.end){stop();return}
        draw();
        progress(Math.max(0,Math.min(100,100*(video.currentTime-range.start)/(range.end-range.start))));
        tick=requestAnimationFrame(animate);
      };
      if(signal.aborted)throw signal.reason;
      recorder.start(1000);
      const playing=video.play();
      timer=setTimeout(()=>fail(new Error('影片匯出逾時，請保持此分頁在前景。')),(range.end-range.start+20)*1000);
      await playing;
      animate();
      const blob=await recorded;
      return blob.type.startsWith('video/webm')?await addWebmDuration(blob,range.end-range.start):blob;
    }finally{
      listeners.abort();
      clearTimeout(timer);
      cancelAnimationFrame(tick);
      video.pause();
      if(recorder&&recorder.state!=='inactive')recorder.stop();
      stream?.getTracks().forEach(track=>track.stop());
      video.removeAttribute('src');
      video.load();
      await audio.close().catch(()=>{});
    }
  }
  function controls(job,media,url){
    const group=el('div',undefined,'result-editor');
    const toolbar=el('div',undefined,'result-upscale-actions');
    const pane=el('div',undefined,'video-edit-pane');
    const status=el('p',undefined,'video-edit-status');
    status.setAttribute('role','status');
    pane.hidden=true;
    group.append(toolbar,pane,status);
    const name=fileStem(job.result.file);
    let transfer,outputUrl;
    function clearPane(){
      transfer?.abort();
      transfer=null;
      if(outputUrl)URL.revokeObjectURL(outputUrl);
      outputUrl=null;
      pane.replaceChildren();
      pane.hidden=true;
      status.textContent='';
    }
    editors.set(group,clearPane);
    const multi=button('+多模態');
    toolbar.append(multi);
    async function addReference(file){
      if(!window.songyinJobs)throw new Error('創作區尚未就緒，請稍後再試。');
      await window.songyinJobs.addPlaybackReference(file);
      status.textContent='已加入創作區的多模態參考素材。';
    }
    multi.addEventListener('click',async()=>{
      multi.disabled=true;
      try{
        const elapsed=job.result.media?.duration;
        if(job.kind!=='image'&&Number.isFinite(elapsed)&&(Math.round(elapsed*100)/100<2||Math.round(elapsed*100)/100>15)){
          throw new Error(job.kind==='video'?'參考影片須為 2–15 秒，請先裁剪。':'參考音訊須為 2–15 秒。');
        }
        if(job.result.bytes>100*1024*1024)throw new Error('這個作品超過參考素材 100 MB 上限。');
        status.textContent='正在加入多模態素材…';
        const response=await fetch(url);
        if(!response.ok)throw new Error('無法讀取作品檔案。');
        const blob=await response.blob();
        await addReference(new File([blob],job.result.file,{type:blob.type}));
      }catch(error){status.textContent=error.message}
      finally{multi.disabled=false}
    });
    if(job.kind!=='video')return group;

    for(const [slot,label] of [['first','+首幀'],['last','+尾幀']]){
      const add=button(label);
      add.title='將目前播放畫面設為'+label.slice(1);
      toolbar.insertBefore(add,multi);
      add.addEventListener('click',async()=>{
        add.disabled=true;
        try{
          const blob=await png(still(media));
          const file=new File([blob],name+'-'+label.slice(1)+'.png',{type:'image/png'});
          if(!window.songyinJobs)throw new Error('創作區尚未就緒，請稍後再試。');
          window.songyinJobs.addPlaybackFrame(file,slot);
          status.textContent='已將目前畫面設為創作區的'+label.slice(1)+'。';
        }catch(error){status.textContent=error.message}
        finally{add.disabled=false}
      });
    }
    const trim=button('裁剪影片');
    const crop=button('框取後截圖');
    toolbar.append(trim,crop);
    function showPane(){
      clearPane();
      pane.hidden=false;
      media.pause();
    }
    function region(){
      const frame=selectableFrame(media);
      pane.append(el('p','拖曳選區，或使用方向鍵移動、Shift 加方向鍵調整大小。'),frame.stage);
      return frame;
    }
    function offer(blob,filename,text){
      if(outputUrl)URL.revokeObjectURL(outputUrl);
      outputUrl=URL.createObjectURL(blob);
      const download=el('a',text,'subtle-button');
      download.href=outputUrl;
      download.download=filename;
      return download;
    }
    crop.addEventListener('click',()=>{
      showPane();
      try{
        const frame=region();
        const actions=el('div',undefined,'result-upscale-actions');
        const save=button('擷取選區');
        const close=button('關閉');
        actions.append(save,close);
        pane.append(actions);
        close.addEventListener('click',clearPane);
        save.addEventListener('click',async()=>{
          try{
            const blob=await frame.screenshot();
            actions.querySelector('a')?.remove();
            actions.append(offer(blob,name+'-截圖.png','下載 PNG'));
          }catch(error){status.textContent=error.message}
        });
      }catch(error){clearPane();status.textContent=error.message}
    });
    trim.addEventListener('click',()=>{
      if(!Number.isFinite(media.duration)||media.duration<=0){
        status.textContent='影片長度讀取後即可裁剪。';
        return;
      }
      showPane();
      const timebox=el('div',undefined,'video-edit-times');
      function timeInput(text,value){
        const label=el('label',text);
        const input=el('input');
        Object.assign(input,{type:'number',min:'0',max:String(media.duration),step:'0.01',value:String(value)});
        const set=button('用播放位置');
        set.setAttribute('aria-label',text+'採用目前播放位置');
        set.addEventListener('click',()=>{input.value=String(Math.min(media.duration,media.currentTime).toFixed(2))});
        label.append(input);
        const item=el('div');
        item.append(label,set);
        timebox.append(item);
        return input;
      }
      const from=timeInput('起點（秒）',0),to=timeInput('終點（秒）',Number(media.duration.toFixed(2)));
      const spatial=el('label','裁切畫面');
      const check=el('input');
      check.type='checkbox';
      spatial.prepend(check);
      const selection=el('div',undefined,'video-edit-selection');
      let frame=null;
      check.addEventListener('change',()=>{
        selection.replaceChildren();
        frame=null;
        if(!check.checked)return;
        try{
          media.pause();
          frame=selectableFrame(media);
          selection.append(el('p','拖曳要保留的畫面範圍。'),frame.stage);
        }catch(error){check.checked=false;status.textContent=error.message}
      });
      const actions=el('div',undefined,'result-upscale-actions');
      const capture=button('匯出裁剪影片'),close=button('關閉');
      actions.append(capture,close);
      close.addEventListener('click',clearPane);
      pane.append(timebox,spatial,selection,actions);
      const output=el('div',undefined,'result-upscale-actions');
      pane.append(output);
      capture.addEventListener('click',async()=>{
        const start=Number(from.value),end=Math.min(Number(to.value),media.duration);
        if(!from.value||!to.value||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end-start<.25){
          status.textContent='請設定有效的起點和終點，片段至少 0.25 秒。';
          return;
        }
        output.replaceChildren();
        const task=new AbortController();
        transfer=task;
        capture.disabled=true;
        status.textContent='正在準備匯出…';
        try{
          const blob=await recordClip(media.currentSrc||url,{start,end},frame?.area(),job.result.media?.fps,task.signal,
            percent=>{status.textContent='正在匯出 '+Math.round(percent)+'%'});
          if(task.signal.aborted)return;
          const extension=blob.type.startsWith('video/mp4')?'mp4':'webm';
          const filename=name+'-裁剪.'+extension;
          output.append(offer(blob,filename,'下載裁剪影片'));
          const use=button('裁剪片段 +多模態');
          use.addEventListener('click',async()=>{
            use.disabled=true;
            try{await addReference(new File([blob],filename,{type:blob.type}))}
            catch(error){status.textContent=error.message}
            finally{use.disabled=false}
          });
          output.append(use);
          status.textContent='影片已匯出。';
        }catch(error){
          if(!task.signal.aborted)status.textContent=error.message;
        }finally{
          if(transfer===task)transfer=null;
          capture.disabled=false;
        }
      });
    });
    return group;
  }
  window.songyinVideoEditor={
    controls,
    clear(container){for(const group of container.querySelectorAll('.result-editor'))editors.get(group)?.()},
  };
})();
