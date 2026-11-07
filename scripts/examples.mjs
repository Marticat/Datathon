import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { officialSubmissionRubric } from '../server/submission.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const groupId='EXTERNAL-ABCD';
const command=process.argv[2]||'list';
const base=process.env.CQA_URL||'http://127.0.0.1:3000';
async function request(path,body){const response=await fetch(base+path,{...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});const data=await response.json();if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);return data;}
async function verified(source){
 const directory=resolve(root,'samples'),file=resolve(directory,source.file),rel=relative(directory,file);
 if(rel.startsWith('..')||isAbsolute(rel))throw Error('Неверный путь примера.');
 const bytes=await readFile(file);if(createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw Error(`Файл изменён: ${source.file}. Проверьте samples/manifest.json.`);return bytes;
}
try{
 if(!['list','import','audio','evaluate'].includes(command)||process.argv.length>3)throw Error('Использование: npm run examples -- list|import|audio|evaluate');
 const url=new URL(base);if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Разрешён только локальный адрес CQA_URL.');
 const manifest=JSON.parse(await readFile(resolve(root,'samples/manifest.json'),'utf8'));
 if(command==='list'){
  for(const source of manifest.sources){await verified(source);console.log(`${source.dataset}: ${source.file} · ${source.license}${source.durationSec?' · '+source.durationSec+' сек.':''}`);}
  console.log('Контрольные суммы проверены. import — добавить 3 чата; audio — распознать 2 звонка; evaluate — оценить 3 чата.');
 }else if(command==='audio'){
  const existing=(await request('/api/audio/jobs')).jobs;
  for(const source of manifest.sources.filter(s=>s.dataset.startsWith('Perit'))){
   const bytes=await verified(source);let job=existing.find(j=>j.sha256===source.sha256&&j.channelMode==='separate'&&j.status!=='failed');
   if(!job){const filename='perit-'+source.file.split('/').at(-1);const response=await fetch(base+`/api/audio/upload?filename=${encodeURIComponent(filename)}&language=EN&speakers=2&channelMode=separate`,{method:'POST',headers:{'content-type':'audio/flac'},body:bytes,signal:AbortSignal.timeout(30000)});job=await response.json();if(!response.ok)throw Error(job.error);}
   console.log(`${source.file}: ${base}/audio?job=${job.id} (${job.status})`);
  }
  console.log('После распознавания проверьте текст и явно назначьте роли голосам. Номер канала/голоса сам по себе не определяет роль. Затем подтвердите диалог и запустите оценку.');
 }else{
  const source=manifest.sources.find(s=>s.dataset==='ABCD');const payload=JSON.parse((await verified(source)).toString('utf8'));
  await request('/api/import',{groupId,payload});console.log(`Импортировано ${payload.length} чата: ${base}/?group=${groupId}`);
  if(command==='evaluate'){
   const state=await request('/api/state');const rubric=officialSubmissionRubric(state);
   const job=await request('/api/jobs',{conversationIds:payload.map(c=>c.conversation_id),rubricId:rubric.id});
   console.log(`Запущена настоящая локальная оценка: ${job.id}. Прогресс и результаты — в интерфейсе. Ранее поставленные задачи будут выполнены первыми.`);
  }
 }
}catch(error){console.error('Примеры не подготовлены: '+error.message);process.exitCode=1;}
