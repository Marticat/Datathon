import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { buildSubmission, validateSubmission, submissionConversations, officialSubmissionRubric } from '../server/submission.mjs';
import { hash, normalizeConversations } from '../server/domain.mjs';
import { PROMPT_VERSION } from '../server/model.mjs';

const {values,positionals}=parseArgs({options:{team:{type:'string'},group:{type:'string'},input:{type:'string'},job:{type:'string'},evaluate:{type:'boolean'},fresh:{type:'boolean'},fetch:{type:'boolean'},check:{type:'boolean'},help:{type:'boolean'}},allowPositionals:true});
const split=positionals[0];
const base=process.env.CQA_URL||'http://127.0.0.1:3000';
async function request(path,body){
 const response=await fetch(base+path,{...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),signal:AbortSignal.timeout(70000)});
 const result=await response.json();if(!response.ok)throw Error(result.error||`HTTP ${response.status}`);return result;
}
async function readJson(file){return JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));}
async function atomicJson(file,value){
 await mkdir(dirname(file),{recursive:true});const temporary=file+`.${process.pid}.tmp`;await writeFile(temporary,JSON.stringify(value,null,2)+'\n','utf8');
 for(let attempt=0;;attempt++){try{await rename(temporary,file);return;}catch(error){if(!['EPERM','EBUSY','EACCES'].includes(error.code)||attempt===7)throw error;await new Promise(done=>setTimeout(done,50*(attempt+1)));}}
}
const sourceSignature=conversations=>hash(conversations.map(c=>[c.conversation_id,c.hash]).sort((a,b)=>a[0].localeCompare(b[0])));

try {
 if(values.help){console.log('npm run submit -- dev|prod [--evaluate] [--input FILE | --fetch] [--group GROUP] [--team NAME] [--job ID] [--fresh] [--check]\nБез --evaluate: выгрузить уже сохранённые оценки. --evaluate: оценить весь набор, дождаться и выгрузить.\nПовтор --evaluate возобновляет сохранённую задачу. --fresh начинает новую оценку.\n--check проверяет готовый results/<набор>/results.json по исходным ID и репликам. Commit и push выполняются отдельно.');}
 else {
  if(!['dev','prod'].includes(split)||positionals.length!==1)throw Error('Укажите один набор: dev или prod. Для справки: npm run submit -- --help');
  if(values.input&&values.fetch)throw Error('Выберите --input или --fetch.');
  if(values.check&&(values.evaluate||values.job||values.input||values.fetch||values.fresh))throw Error('--check только проверяет файл; не совмещайте с обработкой данных.');
  if(values.fresh&&!values.evaluate)throw Error('--fresh требует --evaluate.');
  const config=await readJson(resolve('submission.config.json'));
  const teamName=values.team||config.team_name;
  if(typeof teamName!=='string'||!teamName.trim())throw Error('Укажите название команды в submission.config.json или --team.');
  const groupId=values.group||split.toUpperCase();
  if(values.input||values.fetch){
   const payload=values.input?await readJson(resolve(values.input)):undefined;
   if(payload!==undefined)submissionConversations({conversations:normalizeConversations(payload,groupId)},split,groupId);
   await request('/api/import',{groupId,payload,submissionSplit:split});
  }
  let state=await request('/api/state');
  const conversations=submissionConversations(state,split,groupId);
  const output=resolve('results',split,'results.json');
  const receiptFile=resolve('.local',`submission-${split}-export.json`);
  if(values.check){
   const document=await readJson(output);validateSubmission(document,conversations,split);
   const receipt=await readJson(receiptFile);
   if(receipt.documentHash!==hash(document)||receipt.sourceSignature!==sourceSignature(conversations)||receipt.groupId!==groupId)throw Error('Файл или исходные диалоги изменены после выгрузки. Выполните актуальную выгрузку.');
   if(document.team_name!==teamName.trim())throw Error('Название команды изменилось. Выполните актуальную выгрузку.');
   const errors=document.results.filter(r=>r.status==='error').length;
   console.log(`Формат проверен: ${document.results.length} записей; ошибок обработки: ${errors}. ${output}`);
   if(errors)process.exitCode=2;
  } else {
   let jobId=values.job;
   if(values.evaluate&&!jobId){
    const rubric=officialSubmissionRubric(state);
    const signature=hash({groupId,prompt:PROMPT_VERSION,rubric:rubric.hash,model:state.settings.model,sources:conversations.map(c=>[c.conversation_id,c.hash])});
    const manifestFile=resolve('.local',`submission-${split}.json`);
    let manifest;try{manifest=await readJson(manifestFile);}catch(error){if(error.code!=='ENOENT')throw error;}
    const previous=!values.fresh&&manifest?.signature===signature&&state.jobs.find(j=>j.id===manifest.jobId);
    if(previous)jobId=previous.id;
    else {
     const job=await request('/api/jobs',{conversationIds:conversations.map(c=>c.conversation_id),rubricId:rubric.id});jobId=job.id;
     await atomicJson(manifestFile,{jobId,signature,groupId,createdAt:new Date().toISOString()});
    }
   }
   if(jobId){
    state=await request('/api/state');const target=state.jobs.find(j=>j.id===jobId);
    const rubric=officialSubmissionRubric(state);
    if(!target||target.rubricId!==rubric.id||target.conversationIds.length!==conversations.length||!conversations.every(c=>target.conversationIds.includes(c.conversation_id)))throw Error('Выбранная задача не соответствует набору или официальному чек-листу.');
    console.log(`Задача ${jobId}. Можно прервать команду: сервер сохраняет прогресс. Продолжить: npm run submit -- ${split} --group ${JSON.stringify(groupId)} --job ${jobId}`);
    let seen=-1;
    while(true){
     state=await request('/api/state');const job=state.jobs.find(j=>j.id===jobId);if(!job)throw Error('Задача не найдена.');
     if(job.results.length!==seen){seen=job.results.length;console.log(`${seen}/${job.conversationIds.length}; ошибок: ${job.results.filter(r=>r.error).length}; ${job.status}`);}
     if(job.status==='completed')break;
     if(!['running','queued'].includes(job.status))throw Error(`Неожиданный статус задачи: ${job.status}`);
     await new Promise(done=>setTimeout(done,2000));
    }
   }
   const document=buildSubmission(state,{split,groupId,teamName,jobId});
   await atomicJson(output,document);
   validateSubmission(await readJson(output),submissionConversations(state,split,groupId),split);
   await atomicJson(receiptFile,{documentHash:hash(document),sourceSignature:sourceSignature(submissionConversations(state,split,groupId)),groupId,jobId:jobId??null,exportedAt:new Date().toISOString()});
   const errors=document.results.filter(r=>r.status==='error').length;
   console.log(`Сохранено: ${output}\n${document.results.length-errors} успешных; ${errors} ошибок. Файл проверен. Commit и push ещё НЕ выполнены.`);
   if(errors){console.error('Ошибки сохранены по правилам организаторов; это не успешные AI-оценки. Проверьте их перед сдачей.');process.exitCode=2;}
  }
 }
}catch(error){console.error(`Сдача не завершена: ${error.message}`);process.exitCode=1;}
