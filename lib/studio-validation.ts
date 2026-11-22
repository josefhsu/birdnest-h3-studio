import {checkReferences,getLimits} from '../public/h3-references.mjs';
export const creatorVideoSettings={resolution:'480P',seconds:15,upscale:2} as const;
export const extremeRealismVideoLora='extreme-realism-v3';
export const videoUpscaleFactors=[1.5,2,3,4] as const;
export const isVideoUpscaleFactor=(value:unknown): value is typeof videoUpscaleFactors[number] =>
  videoUpscaleFactors.some(factor=>value===factor);

export function applyCreatorVideoSettings<T>(job:T){
 const value=job as {type?:string}|null;
 return value?.type==='video'?{...job,...creatorVideoSettings}:job;
}

export function validateJob(value:unknown,allowVideoLora=false){
 const j=value as Record<string,any>;
 if(!j||typeof j!=='object'||!/^job_[a-zA-Z0-9_-]{1,90}$/.test(j.id)||!['video','image','tts'].includes(j.type)||typeof j.prompt!=='string'||!j.prompt.trim()||j.prompt.length>12000)throw new Error('工作格式不正確');
 const result:Record<string,any>={id:j.id,type:j.type,prompt:j.prompt.trim()};
 if(j.type!=='image'){if(!Number.isInteger(j.seconds)||j.seconds<2||j.seconds>15)throw new Error('長度必須為 2–15 秒');result.seconds=j.seconds;}
 if(j.type!=='tts'){if(!['16:9','9:16','1:1','4:3','3:4','21:9'].includes(j.aspect))throw new Error('畫面比例不正確');result.aspect=j.aspect;}
 if(j.type==='video'){if(!['ref','frames','text'].includes(j.mode)||!['480P','720P','1080P'].includes(j.resolution))throw new Error('影片設定不正確');Object.assign(result,{mode:j.mode,resolution:j.resolution});}
 if(j.type==='video'&&j.upscale!==undefined){
  if(j.upscale!==1&&!isVideoUpscaleFactor(j.upscale))throw new Error('影片放大倍率不正確');
  if(j.upscale!==1)result.upscale=j.upscale;
 }
 if(j.lora!==undefined){
  if(!allowVideoLora||j.type!=='video'||j.lora!==extremeRealismVideoLora)throw new Error('影片 LoRA 設定不正確');
  result.lora=j.lora;
 }
 if(j.type==='image'){if(!['1K','1.6K','2K','2.7K'].includes(j.size))throw new Error('圖片尺寸不正確');result.size=j.size;}
 if(!Array.isArray(j.files)||j.files.length>getLimits(j.type,j.mode).total)throw new Error('素材數量不正確');
 result.files=j.files.map((f:any)=>{if(!f||!/^asset_[a-zA-Z0-9_-]{1,90}$/.test(f.id)||typeof f.name!=='string'||f.name.length>250||typeof f.type!=='string'||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>100*1024*1024)throw new Error('素材格式不正確');if(!/^(image|audio|video)\//.test(f.type))throw new Error('只接受圖片、影片與聲音素材');return{id:f.id,name:f.name,type:f.type,bytes:f.bytes,...(typeof f.duration==='number'&&Number.isFinite(f.duration)&&f.duration>0?{duration:f.duration}:{})};});
 const warning=checkReferences(j.type,j.mode,result.prompt,result.files);
 if(warning)throw new Error(warning);
 return result;
}
export function owner(request:Request){const id=request.headers.get('oai-authenticated-user-id');if(!id)throw new Error('請先登入私人工作室');return id;}
export function sameOrigin(request:Request){if(request.headers.get('origin')!==new URL(request.url).origin)throw new Error('請由工作室頁面送出');}
