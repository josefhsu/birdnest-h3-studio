export const maxBytes=100*1024*1024;
export const extensionTypes={
  png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',bmp:'image/bmp',
  mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm',mkv:'video/x-matroska',avi:'video/x-msvideo',
  wav:'audio/wav',mp3:'audio/mpeg',flac:'audio/flac',ogg:'audio/ogg',m4a:'audio/mp4',aac:'audio/aac',
};
export const labels={image:'圖片',video:'影片',audio:'音訊'};
const aliases={圖片:'image',图片:'image',image:'image',picture:'image',
  影片:'video',视频:'video',video:'video',音訊:'audio',音频:'audio',audio:'audio'};
const expression=/@(圖片|图片|Image|Picture|影片|视频|Video|音訊|音频|Audio)\s*(?:\(\s*(\d+)\s*\)|(\d+))|<(Picture|Video|Audio)\s+(\d+)>/gi;
const tagNames={image:'Image',video:'Video',audio:'Audio'};
export const mediaType=name=>extensionTypes[String(name).match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase()]||'';
export const fileKind=file=>file.type.split('/')[0];
export const usesReferenceTags=(kind,mode)=>kind!=='video'||!['text','frames'].includes(mode);
export function filesForMode(kind,mode,files){
  if(kind!=='video')return files;
  if(mode==='text')return [];
  if(mode==='frames')return files.filter(file=>fileKind(file)==='image').slice(0,2);
  return files;
}
export function submissionPrompt(kind,mode,prompt){
  if(usesReferenceTags(kind,mode))return prompt;
  return prompt.split('\n').map(line=>{
    const clean=line.replace(expression,'').replace(/@Subject(?:\s*\(\s*\d+\s*\)|\s*\d+\b)/gi,'');
    if(clean===line)return line;
    if(/^(?:參考素材\s*[：:])?[\s、，,；;／/]*$/u.test(clean.trim()))return null;
    return clean.replace(/[ \t]+(?=[，。！？、；：,.!?;:]|$)/g,'').replace(/ {2,}/g,' ');
  }).filter(line=>line!==null).join('\n').trim();
}
export function getLimits(kind,mode){
  if(kind==='image')return {image:8,video:0,audio:0,total:8};
  if(kind==='tts')return {image:0,video:0,audio:3,total:3};
  if(mode==='frames')return {image:2,video:0,audio:0,total:2};
  if(mode==='text')return {image:0,video:0,audio:0,total:0};
  return {image:9,video:3,audio:3,total:12};
}
export function labelAssets(files){
  const counts={image:0,video:0,audio:0};
  return files.map(file=>{
    const kind=fileKind(file);
    const index=++counts[kind];
    return {...file,kind,index,tag:'@'+tagNames[kind]+'('+index+')'};
  });
}
export function mentions(text){
  return Array.from(text.matchAll(expression),match=>({
    text:match[0],kind:aliases[(match[1]||match[4]).toLowerCase()],index:Number(match[2]||match[3]||match[5])
  }));
}
export function normalizeReferences(text,style='at'){
  const model={image:'Picture',video:'Video',audio:'Audio'};
  return text.replace(expression,(_all,at,paren,plain,xml,xmlIndex)=>{
    const kind=aliases[(at||xml).toLowerCase()];
    const n=Number(paren||plain||xmlIndex);
    return style==='at'?'@'+labels[kind]+n:'<'+model[kind]+' '+n+'>';
  });
}
export function removeReference(text,kind,index){
  return text.replace(expression,(all,at,paren,plain,xml,xmlNumber)=>{
    if(aliases[(at||xml).toLowerCase()]!==kind)return all;
    const value=Number(paren||plain||xmlNumber);
    if(value===index)return '';
    if(value<index)return all;
    return at?'@'+at+(paren?'('+(value-1)+')':value-1):'<'+xml+' '+(value-1)+'>';
  });
}
export function reorderReferenceTags(text,before,after){
  const positions=new Map();
  labelAssets(after).forEach((file,i)=>positions.set(after[i],file.index));
  const replacements=new Map();
  labelAssets(before).forEach((file,i)=>{
    const next=positions.get(before[i]);
    if(next&&next!==file.index)replacements.set(file.kind+file.index,next);
  });
  return text.replace(expression,(all,at,paren,plain,xml,xmlIndex)=>{
    const kind=aliases[(at||xml).toLowerCase()];
    const next=replacements.get(kind+Number(paren||plain||xmlIndex));
    return next?all.replace(/\d+/,String(next)):all;
  });
}
export function checkReferences(kind,mode,prompt,files,{editing=false}={}){
  const limits=getLimits(kind,mode);
  const counts={image:0,video:0,audio:0};
  const lengths={video:0,audio:0};
  let bytes=0;
  for(const file of files){
    const expected=mediaType(file.name);
    const category=fileKind(file);
    if(!expected||expected.split('/')[0]!==category)return '不支援的素材格式：'+file.name;
    counts[category]++;
    bytes+=file.bytes??file.size??file.blob?.size??0;
    if(counts[category]>limits[category]){
      return limits[category]?`${labels[category]}最多 ${limits[category]} 個。`:'目前的生成模式不能加入'+labels[category]+'。';
    }
    if(kind==='video'&&mode==='ref'&&['video','audio'].includes(category)&&Number.isFinite(file.duration)){
      const seconds=Math.round(file.duration*100)/100;
      if(seconds<2||seconds>15)return `${file.name} 需為 2–15 秒，目前 ${seconds} 秒。`;
      lengths[category]+=seconds;
      if(lengths[category]>15.0001)return labels[category]+'參考素材合計不得超過 15 秒。';
    }
  }
  if(files.length>limits.total)return `此模式合計最多 ${limits.total} 個素材。`;
  if(bytes>maxBytes)return '每項工作的參考素材合計上限是 100 MB。';
  if(editing)return '';
  if(kind==='video'&&mode==='frames'&&!counts.image)return '首尾格模式需要 1–2 張圖片。';
  if(!usesReferenceTags(kind,mode)){
    return submissionPrompt(kind,mode,prompt).trim()?'':'請輸入創作描述。';
  }
  if(kind==='video'&&mode==='ref'&&counts.audio&&!counts.image&&!counts.video)return '使用參考音訊時，請搭配至少一張圖片或一支影片。';
  const used=mentions(prompt);
  const missing=used.filter(item=>!item.index||item.index>counts[item.kind]);
  if(missing.length)return '找不到提示中引用的素材：'+Array.from(new Set(missing.map(item=>item.text))).join('、');
  if(kind==='video'&&mode==='ref'&&files.length&&!used.length)return '請點素材上的標籤，或按「插入所有標籤」，讓 H3 知道要使用哪些檔案。';
  if(kind==='video'&&mode==='ref'&&used.some(x=>x.kind==='audio')&&!used.some(x=>x.kind==='image'||x.kind==='video')){
    return '提示引用音訊時，也請點名至少一項圖片或影片。';
  }
  return '';
}
