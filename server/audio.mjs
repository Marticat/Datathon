import { createReadStream } from 'node:fs';
import { mkdir,open,unlink,readFile,writeFile,rename,stat } from 'node:fs/promises';
import { join,extname,resolve } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { normalizeConversations } from './domain.mjs';
import { transcribeLocal } from './audio-worker.mjs';

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const audioTypes={'.ogg':'audio/ogg','.oga':'audio/ogg','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.mp4':'audio/mp4','.flac':'audio/flac','.webm':'audio/webm','.opus':'audio/ogg'};
const languages=['RU','KZ','EN'];
export function mediaRange(header,size) {
  const match=/^bytes=(\d*)-(\d*)$/.exec(header||'');
  if(!match||!size||!match[1]&&!match[2])fail('Некорректный диапазон.',416);
  const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
  const end=match[1]?(match[2]?Math.min(size-1,Number(match[2])):size-1):size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start||!match[1]&&Number(match[2])===0)fail('Диапазон вне записи.',416);
  return {start,end};
}
function validateResult(result) {
  if(!Number.isFinite(result?.duration)||result.duration<=0||result.duration>1200||!Array.isArray(result.segments)||!result.segments.length||result.segments.length>3000||!Array.isArray(result.speakers)||result.speakers.length>30)fail('Распознавание вернуло некорректный результат.');
  if(!result.speakers.length||new Set(result.speakers).size!==result.speakers.length||result.speakers.some(id=>typeof id!=='string'||!/^(speaker_\d+|unknown)$/.test(id)))fail('Некорректные идентификаторы голосов.');
  const ids=new Set();let previous=-1;
  for(const s of result.segments){
    if(typeof s.id!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(s.id)||ids.has(s.id)||!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.start<previous||s.end<s.start||s.end>result.duration+.1||!result.speakers.includes(s.speaker)||typeof s.text!=='string'||!s.text.trim()||s.text.length>30000)fail('Некорректная реплика распознавания.');
    ids.add(s.id);previous=s.start;
  }
  return result;
}
export function validateAudioDraft(result,input,publish=false) {
  if(!input||!Array.isArray(input.segments)||input.segments.length<1||input.segments.length>9000||!input.roles||typeof input.roles!=='object'||Array.isArray(input.roles))fail('Проверьте расшифровку и роли голосов.');
  const roles={};for(const speaker of result.speakers){const role=input.roles[speaker]||'';if(!['','client','operator','bot','system'].includes(role))fail('Неизвестная роль голоса.');roles[speaker]=role;}
  const seen=new Set();const segments=input.segments.map(s=>{
    const parentId=s.parentId||s.id,source=result.segments.find(original=>original.id===parentId);
    if(!source||typeof s.id!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(s.id)||seen.has(s.id)||!result.speakers.includes(s.speaker)||typeof s.text!=='string'||s.text.length>30000||typeof s.include!=='boolean')fail('Некорректная правка расшифровки.');
    const start=s.start??source.start,end=s.end??source.end;
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<source.start-.001||end>source.end+.001||end<start)fail('Часть реплики должна оставаться в исходном временном диапазоне.');
    const role=s.role||'';if(!['','client','operator','bot','system'].includes(role))fail('Неизвестная роль реплики.');
    seen.add(s.id);if(publish&&s.include&&(!s.text.trim()||!role&&!roles[s.speaker]))fail('Для каждой включённой реплики нужны текст и подтверждённая роль.');
    return {id:s.id,parentId,start,end,speaker:s.speaker,text:s.text,include:s.include,role};
  });
  for(const source of result.segments){
    const parts=segments.filter(s=>s.parentId===source.id).sort((a,b)=>a.start-b.start);
    if(!parts.length||Math.abs(parts[0].start-source.start)>.002||Math.abs(parts.at(-1).end-source.end)>.002||parts.some((s,i)=>i&&Math.abs(s.start-parts[i-1].end)>.002))fail('Части реплики должны покрывать исходный диапазон без пропусков или наложений. Для удаления используйте «Включить».');
  }
  if(publish&&(!languages.includes(input.language)||!segments.some(s=>s.include)))fail('Выберите язык RU/KZ/EN и оставьте хотя бы одну реплику.');
  return {language:languages.includes(input.language)?input.language:null,roles,segments};
}
const timestamp=seconds=>{const ms=Math.round(seconds*1000);return `${String(Math.floor(ms/60000)).padStart(2,'0')}:${String(Math.floor(ms%60000/1000)).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;};
export function confirmedTurns(result,draft) {
  const messages=[];let previous=null;
  for(const source of result.segments){
    const parts=draft.segments.filter(s=>(s.parentId||s.id)===source.id).sort((a,b)=>(a.start??source.start)-(b.start??source.start));
    for(const edit of parts){
      if(!edit.include){previous=null;continue;}
      const role=edit.role||draft.roles[edit.speaker],start=edit.start??source.start,end=edit.end??source.end;
      if(previous&&previous.voice===edit.speaker&&previous.message.speaker===role){previous.message.text+=' '+edit.text.trim();previous.message.endSec=end;}
      else{const message={speaker:role,text:edit.text.trim(),timestamp:timestamp(start),startSec:start,endSec:end};messages.push(message);previous={voice:edit.speaker,message};}
    }
  }
  return messages;
}

export function createAudioService({store,rootDir,worker=transcribeLocal}) {
  rootDir=resolve(rootDir);let running=false;
  const find=id=>{if(!/^[a-f0-9-]{36}$/.test(id))fail('Аудиозапись не найдена.',404);const job=store.read().audioJobs.find(j=>j.id===id);if(!job)fail('Аудиозапись не найдена.',404);return job;};
  const paths=job=>({filePath:join(rootDir,job.id,'source'+job.extension),resultPath:join(rootDir,job.id,'result.json'),playbackPath:join(rootDir,job.id,'playback.wav')});
  const mediaUrls=job=>({audioUrl:`/api/audio/files/${job.id}`+(job.playbackReady?'?track=playback':''),originalAudioUrl:`/api/audio/files/${job.id}?track=original&download=1`});
  const summary=({draft,...job})=>job;
  const result=async job=>JSON.parse(await readFile(paths(job).resultPath,'utf8'));
  async function run(){
    if(running)return;running=true;
    try{while(true){const job=store.read().audioJobs.find(j=>j.status==='queued');if(!job)break;
      const attemptId=randomUUID(),attemptDir=join(rootDir,job.id,'attempt-'+attemptId);await mkdir(attemptDir,{recursive:true});
      store.update(s=>Object.assign(s.audioJobs.find(j=>j.id===job.id),{attemptId,status:'running',stage:'decoding',progress:1,error:null}));
      try{
        let lastProgress=0;
        const output=validateResult(await worker({...job,...paths(job),resultPath:join(attemptDir,'result.json')},progress=>{if(Date.now()-lastProgress<1000)return;lastProgress=Date.now();store.update(s=>{const active=s.audioJobs.find(j=>j.id===job.id);if(active.attemptId===attemptId)Object.assign(active,{stage:String(progress.stage).slice(0,50),progress:Math.max(0,Math.min(99,Number(progress.progress)||0))});});}));
        if(store.read().audioJobs.find(j=>j.id===job.id)?.attemptId!==attemptId)continue;
        if(output.playback)await rename(join(attemptDir,'playback.wav'),paths(job).playbackPath);
        output.sourceSHA256=job.sha256;
        const file=paths(job).resultPath;await writeFile(file+'.tmp',JSON.stringify(output));await rename(file+'.tmp',file);
        store.update(s=>Object.assign(s.audioJobs.find(j=>j.id===job.id),{playbackReady:!!output.playback,status:'needs_review',stage:'needs_review',progress:100,duration:output.duration,language:output.language||job.language,finishedAt:new Date().toISOString()}));
      }catch(error){store.update(s=>Object.assign(s.audioJobs.find(j=>j.id===job.id),{status:'failed',stage:'failed',error:String(error.message).slice(0,1000)}));}
    }}finally{running=false;}
  }
  async function handle(req,res,url,readBody){
    const path=url.pathname;
    const send=(data,status=200)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));};
    if(path==='/api/audio/upload'&&req.method==='POST'){
      const filename=url.searchParams.get('filename')||'';const extension=extname(filename).toLowerCase();
      if(!filename||filename.length>200||/[\x00-\x1f\\/]/.test(filename)||!audioTypes[extension])fail('Выберите аудиофайл OGG, MP3, WAV, M4A, FLAC или WebM.');
      const language=url.searchParams.get('language')||'auto',speakers=url.searchParams.get('speakers')||'auto';
      if(!['auto',...languages].includes(language)||!['auto','1','2','3','4'].includes(speakers))fail('Некорректный язык или количество голосов.');
      const limit=80*1024*1024;if(Number(req.headers['content-length'])>limit)fail('Максимальный размер аудио — 80 МБ.',413);
      const job={id:randomUUID(),filename,extension,language,speakers:speakers==='auto'?-1:Number(speakers),status:'queued',stage:'queued',progress:0,createdAt:new Date().toISOString(),error:null};
      await mkdir(join(rootDir,job.id),{recursive:true});const filePath=paths(job).filePath;const file=await open(filePath,'wx');let size=0;const digest=createHash('sha256');
      try{for await(const chunk of req){size+=chunk.length;if(size>limit)fail('Максимальный размер аудио — 80 МБ.',413);digest.update(chunk);await file.writeFile(chunk);}if(!size)fail('Аудиофайл пуст.');}
      catch(error){await file.close();await unlink(filePath).catch(()=>{});throw error;}
      await file.close();job.size=size;job.sha256=digest.digest('hex');store.update(s=>s.audioJobs.push(job));void run();send({...summary(job),...mediaUrls(job)},202);return true;
    }
    if(path==='/api/audio/jobs'&&req.method==='GET'){send({jobs:store.read().audioJobs.map(job=>({...summary(job),...mediaUrls(job)})).reverse()});return true;}
    const fileMatch=path.match(/^\/api\/audio\/files\/([^/]+)$/);
    if(fileMatch&&['GET','HEAD'].includes(req.method)){
      const job=find(fileMatch[1]),playback=url.searchParams.get('track')==='playback';if(playback&&!job.playbackReady)fail('Запись для проверки ещё не готова.',409);
      const file=playback?paths(job).playbackPath:paths(job).filePath,{size}=await stat(file);
      const headers={'content-type':playback?'audio/wav':audioTypes[job.extension],'accept-ranges':'bytes','cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'"};
      if(url.searchParams.get('download')==='1')headers['content-disposition']="attachment; filename*=UTF-8''"+encodeURIComponent(job.filename);
      let range=null;try{if(req.headers.range)range=mediaRange(req.headers.range,size);}catch{res.writeHead(416,{...headers,'content-range':`bytes */${size}`});res.end();return true;}
      res.writeHead(range?206:200,{...headers,'content-length':range?range.end-range.start+1:size,...(range?{'content-range':`bytes ${range.start}-${range.end}/${size}`}:{})});
      if(req.method==='HEAD')res.end();else{const stream=createReadStream(file,range||{});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);}return true;
    }
    const match=path.match(/^\/api\/audio\/jobs\/([^/]+)(?:\/(draft|publish))?$/);
    if(match){
      const job=find(match[1]);
      if(req.method==='GET'&&!match[2]){let output=null;if(['needs_review','confirmed'].includes(job.status)){const {words,turns,...visible}=await result(job);output=visible;}send({...job,...mediaUrls(job),result:output});return true;}
      if(req.method==='POST'&&['draft','publish'].includes(match[2])){
        if(!['needs_review','confirmed'].includes(job.status))fail('Дождитесь завершения распознавания.',409);
        const output=await result(job),publish=match[2]==='publish',draft=validateAudioDraft(output,await readBody(req),publish);
        let publication=null;
        if(publish){
          const transcript=confirmedTurns(output,draft);
          const [conversation]=normalizeConversations([{conversation_id:'audio-'+job.id,language:draft.language,channel:'voice call',audio_url:`http://${req.headers.host}${mediaUrls(job).audioUrl}`,durationSec:output.duration,transcript}],'AUDIO');
          publication={conversationId:conversation.conversation_id,groupId:'AUDIO',url:`/?group=AUDIO&dialog=${encodeURIComponent(conversation.conversation_id)}`};
          store.update(s=>{const index=s.conversations.findIndex(c=>c.conversation_id===conversation.conversation_id);if(index<0)s.conversations.push(conversation);else s.conversations[index]=conversation;Object.assign(s.audioJobs.find(j=>j.id===job.id),{draft,status:'confirmed',stage:'confirmed',conversationId:conversation.conversation_id,confirmedAt:new Date().toISOString()});});
        }else store.update(s=>{s.audioJobs.find(j=>j.id===job.id).draft=draft;});
        send(publication||{...summary(job),draft});return true;
      }
    }
    return false;
  }
  return {handle,resume:run};
}
