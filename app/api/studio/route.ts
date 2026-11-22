import {studioIdentity} from '../../../lib/studio-access';
import type {Identity} from '../../../lib/studio-access';
import {traditionalPrompt} from '../../../public/h3-prompt-language.mjs';
import {env} from 'cloudflare:workers';
import {applyCreatorVideoSettings,validateJob,sameOrigin} from '../../../lib/studio-validation';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
export async function GET(request:Request){
 let identity:Identity;try{const member=await studioIdentity(request);if(!member)throw new Error();identity=member}catch{return json({error:'請先登入私人工作室'},401)}
 try{
 const rows=await env.DB!.prepare('SELECT id,kind,prompt,manifest,state,result,created_at,updated_at FROM songyin_jobs WHERE owner=? ORDER BY created_at DESC LIMIT 200').bind(identity.id).all();
 const jobs=rows.results.map((row:any)=>{
   const manifest=JSON.parse(row.manifest);
   const prompt=traditionalPrompt(row.prompt,row.kind);
   if(typeof manifest.prompt==='string')manifest.prompt=traditionalPrompt(manifest.prompt,row.kind);
   const applyPolicy=identity.role==='creator'&&manifest.operation!=='upscale'&&['draft','error'].includes(row.state);
   return {...row,prompt,manifest:applyPolicy?applyCreatorVideoSettings(manifest):manifest,result:row.result?JSON.parse(row.result):null};
 });
 return json({controllerReady:true,jobs});
 }catch{return json({error:'暫時無法讀取雲端工作，請稍後重試。'},503)}
}
export async function POST(request:Request){
 let identity:Identity;try{sameOrigin(request);const member=await studioIdentity(request);if(!member)throw new Error();identity=member}catch{return json({error:'請先登入並由工作室頁面操作'},403)}
 try{
 if(Number(request.headers.get('content-length')||0)>512000)return json({error:'工作資料過大'},413);
 const raw=await request.text();if(raw.length>256000)return json({error:'工作資料過大'},413);
 const input=JSON.parse(raw);if(!Array.isArray(input.jobs)||input.jobs.length<1||input.jobs.length>100)return json({error:'一次請同步 1–100 項工作'},400);
 const jobs=input.jobs.map((job:unknown)=>validateJob(
   identity.role==='creator'?applyCreatorVideoSettings(job):job,identity.role==='administrator',
 ));
 const user=identity.id;
 for(const j of jobs)for(const file of j.files){const asset=await env.BUCKET!.head(user+'/'+file.id);if(!asset||asset.size!==file.bytes)return json({error:'素材尚未上傳完整，請重試同步。'},400);}
 const now=Date.now();await env.DB!.batch(jobs.map((j:any)=>env.DB!.prepare('INSERT INTO songyin_jobs(id,owner,kind,prompt,manifest,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET prompt=excluded.prompt,manifest=excluded.manifest,updated_at=excluded.updated_at WHERE songyin_jobs.owner=excluded.owner AND songyin_jobs.state=\'draft\'').bind(j.id,user,j.type,j.prompt,JSON.stringify(j),'draft',now,now)));
 return json({saved:jobs.length});
 }catch(e){return json({error:e instanceof SyntaxError?'工作資料格式錯誤':e instanceof Error&&/不正確|素材|模式|工作|秒|圖片|聲音|引用|標籤|格式/.test(e.message)?e.message:'儲存失敗，請重試。'},400)}
}
