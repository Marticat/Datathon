import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname, dirname, join } from 'node:path';
import { Store } from './store.mjs';
import { validateRubric, normalizeConversations, validateAnswers, validateAnswer, calculateScore, hash, text } from './domain.mjs';
import { evaluateLocal, modelStatus, PROMPT_VERSION } from './model.mjs';
import { createAudioService } from './audio.mjs';

const error=(message,status=400)=>Object.assign(new Error(message),{status});
const get=(array,id,label)=>{const value=array.find(x=>x.id===id||x.conversation_id===id);if(!value)throw error(`${label} не найден.`,404);return value;};
export async function readJsonBody(req){const chunks=[];let size=0;for await(const chunk of req){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>5*1024*1024)throw error('Файл слишком большой (максимум 5 МБ).',413);chunks.push(bytes);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw error('Некорректный JSON.');}}
const body=readJsonBody;
export function createApp({dataFile=resolve('.local/state.json'),evaluator=evaluateLocal,publicDir=resolve('public'),datasetUrl=process.env.DATASET_URL,audioWorker}={}) {
  const store=new Store(dataFile);let work=Promise.resolve();let queueRunning=false;
  const audio=createAudioService({store,rootDir:join(dirname(dataFile),'audio'),worker:audioWorker});
  const serialize=fn=>{const task=work.then(fn);work=task.catch(()=>{});return task;};
  async function evaluate(conversationId,rubricId,snapshots=null,jobId=null) {
    const snapshot=store.read();const conversation=snapshots?.conversation??get(snapshot.conversations,conversationId,'Диалог');const rubric=snapshots?.rubric??get(snapshot.rubrics,rubricId,'Чек-лист');
    const settings=snapshots?.settings??snapshot.settings;const started=Date.now();let output,answers;
    try {output=await evaluator(conversation,rubric,settings);answers=validateAnswers(rubric,conversation,output.answers);}catch(e){throw error(`Оценка не получена: ${e.message}`,502);}
    const score=calculateScore(rubric,answers);
    const evaluation={id:randomUUID(),conversationId,conversationHash:conversation.hash,conversationSnapshot:conversation,rubricId,rubricHash:rubric.hash,model:settings.model,modelDigest:output.modelDigest??null,runtimeVersion:output.runtimeVersion??null,promptVersion:output.promptVersion||PROMPT_VERSION,pipelineVersion:output.pipelineVersion||'injected-test',inferenceStages:output.inferenceStages||[],createdAt:new Date().toISOString(),durationMs:Date.now()-started,answers,reviewedAnswers:structuredClone(answers),originalScore:score,finalScore:structuredClone(score),usage:output.usage||{}};
    store.update(state=>{state.evaluations.push(evaluation);if(jobId)get(state.jobs,jobId,'Задача').results.push({conversationId,evaluationId:evaluation.id});});return evaluation;
  }
  async function runQueue(){
    if(queueRunning)return;queueRunning=true;
    try {while(true){const job=store.read().jobs.find(x=>x.status==='queued');if(!job)break;
      store.update(s=>{const j=get(s.jobs,job.id,'Задача');j.status='running';});
      for(const conversationId of job.conversationIds){if(job.results.some(r=>r.conversationId===conversationId))continue;
        store.update(s=>{get(s.jobs,job.id,'Задача').currentConversationId=conversationId;});
        try {await serialize(()=>evaluate(conversationId,job.rubricId,{conversation:job.snapshots?.find(c=>c.conversation_id===conversationId),rubric:get(store.read().rubrics,job.rubricId,'Чек-лист'),settings:job.settings},job.id));}
        catch(e){store.update(s=>{get(s.jobs,job.id,'Задача').results.push({conversationId,error:e.message});});}
      }
      store.update(s=>{const j=get(s.jobs,job.id,'Задача');j.status='completed';j.currentConversationId=null;delete j.snapshots;});
    }}finally{queueRunning=false;}
  }
  function publicState(){const {audioJobs,...state}=store.read();state.jobs=state.jobs.map(({snapshots,settings,...job})=>job);return state;}
  const server=createServer(async(req,res)=>{
    const send=(data,status=200)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));};
    try {
      const host=req.headers.host||'';if(!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host))throw error('Недопустимый адрес сервера.',403);
      const url=new URL(req.url,'http://'+host);const path=url.pathname;
      if(req.method==='POST') {if(req.headers.origin&&req.headers.origin!==`http://${host}`)throw error('Запрос с другого сайта запрещён.',403);if(path!=='/api/audio/upload'&&!req.headers['content-type']?.startsWith('application/json'))throw error('Нужен Content-Type application/json.',415);}
      if(path.startsWith('/api/audio/')&&await audio.handle(req,res,url,body))return;
      if(req.method==='GET'&&path==='/api/state')return send(publicState());
      if(req.method==='GET'&&path==='/api/health'){const settings=store.read().settings;return send({ok:true,model:settings.model,ollama:await modelStatus(settings),datasetConfigured:Boolean(datasetUrl)});}
      if(req.method==='GET'&&path==='/api/export'){res.setHeader('content-disposition','attachment; filename="cqa-results.json"');const {settings,...state}=publicState();return send({...state,exportedAt:new Date().toISOString()});}
      if(req.method==='POST'&&path==='/api/import'){
        const input=await body(req);const groupId=text(input.groupId||'UPLOAD','Группа',100);let payload=input.payload;
        if(payload===undefined){if(!datasetUrl)throw error('URL организаторов не настроен. Загрузите JSON или задайте DATASET_URL в .env.');
          const remote=new URL(datasetUrl);remote.searchParams.set('group_id',groupId);
          let response;try{response=await fetch(remote,{signal:AbortSignal.timeout(60000)});}catch{throw error('API организаторов недоступен. Можно загрузить сохранённый JSON.',502);}
          if(!response.ok)throw error(`Ошибка API организаторов: ${response.status}`,502);payload=await response.json();}
        const normalized=normalizeConversations(payload,groupId);
        store.update(s=>{for(const c of normalized){const at=s.conversations.findIndex(x=>x.conversation_id===c.conversation_id);if(at>=0)s.conversations[at]=c;else s.conversations.push(c);}});return send({imported:normalized.length});
      }
      if(req.method==='POST'&&path==='/api/rubrics'){
        const clean=validateRubric(await body(req));const rubric={...clean,id:randomUUID(),version:store.read().rubrics.length+1,hash:hash(clean.criteria),createdAt:new Date().toISOString()};store.update(s=>s.rubrics.push(rubric));return send(rubric);
      }
      if(req.method==='POST'&&path==='/api/settings'){
        const input=await body(req);const model=text(input.model,'Модель',200);if(/cloud/i.test(model))throw error('Облачные модели запрещены: выберите локальную.');
        const status=await modelStatus(store.read().settings);if(!status.online||!status.models.includes(model))throw error('Модель не установлена в локальном Ollama.');
        store.update(s=>{s.settings.model=model;});return send(store.read().settings);
      }
      if(req.method==='POST'&&path==='/api/evaluate'){
        const input=await body(req);const s=store.read();const conversation=get(s.conversations,input.conversationId,'Диалог'),rubric=get(s.rubrics,input.rubricId,'Чек-лист');
        const evaluation=await serialize(()=>evaluate(conversation.conversation_id,rubric.id,{conversation,rubric,settings:s.settings}));return send(evaluation);
      }
      if(req.method==='POST'&&path==='/api/jobs'){
        const input=await body(req);const state=store.read();get(state.rubrics,input.rubricId,'Чек-лист');
        if(!Array.isArray(input.conversationIds)||!input.conversationIds.length||input.conversationIds.length>1000)throw error('Выберите от 1 до 1000 диалогов.');
        const ids=[...new Set(input.conversationIds)];const snapshots=ids.map(id=>get(state.conversations,id,'Диалог'));
        const job={id:randomUUID(),status:'queued',conversationIds:ids,rubricId:input.rubricId,createdAt:new Date().toISOString(),results:[],currentConversationId:null,snapshots,settings:state.settings};store.update(s=>s.jobs.push(job));void runQueue();const {snapshots:_,settings:__,...visible}=job;return send(visible,202);
      }
      if(req.method==='POST'&&path==='/api/appeals'){
        const input=await body(req);const state=store.read();const ev=get(state.evaluations,input.evaluationId,'Оценка');const rubric=get(state.rubrics,ev.rubricId,'Чек-лист');get(rubric.criteria,input.criterionId,'Критерий');
        if(state.appeals.some(a=>a.evaluationId===ev.id&&a.criterionId===input.criterionId&&a.status==='open'))throw error('Для критерия уже есть открытая апелляция.',409);
        const appeal={id:randomUUID(),evaluationId:ev.id,criterionId:input.criterionId,comment:text(input.comment,'Комментарий',4000),status:'open',createdAt:new Date().toISOString(),decision:null};store.update(s=>s.appeals.push(appeal));return send(appeal);
      }
      const appealMatch=path.match(/^\/api\/appeals\/([^/]+)\/resolve$/);
      if(req.method==='POST'&&appealMatch){
        const input=await body(req);const reason=text(input.reason,'Причина решения',4000);
        const result=store.update(s=>{const appeal=get(s.appeals,appealMatch[1],'Апелляция');if(appeal.status==='resolved')throw error('Апелляция уже рассмотрена.',409);
          const evaluation=get(s.evaluations,appeal.evaluationId,'Оценка');const rubric=get(s.rubrics,evaluation.rubricId,'Чек-лист');const criterion=get(rubric.criteria,appeal.criterionId,'Критерий');validateAnswer(criterion,input.answer);
          appeal.status='resolved';appeal.decision={answer:input.answer,reason,createdAt:new Date().toISOString()};
          const answer=evaluation.reviewedAnswers.find(a=>a.criterionId===criterion.id);answer.answer=input.answer;answer.explanation=reason;
          evaluation.finalScore=calculateScore(rubric,evaluation.reviewedAnswers);return {appeal,evaluation};});return send(result);
      }
      if(path.startsWith('/api/'))throw error('Метод API не найден.',404);
      if(req.method!=='GET')throw error('Метод не разрешён.',405);
      const files={'/':'index.html','/index.html':'index.html','/classic':'classic.html','/audio':'audio.html','/audio.js':'audio.js','/audio.css':'audio.css','/app.js':'app.js','/styles.css':'styles.css','/cqa.js':'cqa.js','/cqa-api.js':'cqa-api.js','/cqa-init.js':'cqa-init.js','/cqa.css':'cqa.css','/cqa-extra.css':'cqa-extra.css'};
      if(!files[path])throw error('Файл не найден.',404);
      const content=await readFile(resolve(publicDir,files[path]));const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(files[path])];
      res.writeHead(200,{'content-type':mime+'; charset=utf-8','cache-control':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src https: http:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});res.end(content);
    }catch(e){if(!res.headersSent)send({error:e.status?e.message:'Внутренняя ошибка. Проверьте журнал сервера.'},e.status||500);if(!e.status)console.error(e);}
  });
  server.requestTimeout=0;server.headersTimeout=60000;
  return {server,store,resume:()=>{void runQueue();void audio.resume();}};
}
