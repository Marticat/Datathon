// Bridge the supplied UI to the validated, versioned local CQA server.
export function toChecklist(rubric) {
 const sections=[...new Set(rubric.criteria.map(c=>c.section))].map((title,i)=>({id:'s'+(i+1),title}));
 return {id:rubric.id,name:rubric.name,version:rubric.version,rounding:2,sections,criteria:rubric.criteria.map(c=>({id:c.id,title:c.title,section:sections.find(s=>s.title===c.section).id,desc:c.description,type:c.type==='flag'?'binary':c.type,weight:c.weight,steps:[...c.scale].reverse(),naAllowed:c.allowNA,naRule:c.naRule,gross:c.type==='flag'}))};
}
export function toRubric(checklist) {
 return {name:checklist.name||'Freedom · чек-лист',criteria:checklist.criteria.map(c=>({id:c.id,title:c.title,section:checklist.sections.find(s=>s.id===c.section)?.title||'Общее',description:c.desc,type:c.gross?'flag':c.type,weight:c.gross?0:Number(c.weight),scale:c.type==='scale'?[...c.steps].sort((a,b)=>a-b):[],allowNA:!!c.naAllowed,naRule:c.naAllowed?c.naRule:''}))};
}
const value=v=>v==='yes'?1:v==='no'?0:v;
export function filterDialogs(dialogs,filter={}) {
 const query=(filter.query||'').trim().toLocaleLowerCase();
 return dialogs.filter(d=>(!filter.gross||d.grossAI===true)&&(!filter.language||d.lang===filter.language)&&(!query||[d.id,...d.raw.map(m=>m[2])].join(' ').toLocaleLowerCase().includes(query)));
}
const signature=c=>JSON.stringify([c.title,c.desc||'',c.type,(c.steps||[]).join(','),!!c.naAllowed,!!c.gross]);
function relativeTime(timestamp,first){if(/^\d{4}-/.test(timestamp))return Math.max(0,(Date.parse(timestamp)-Date.parse(first))/1000)||0;return timestamp.split(':').reduce((n,p)=>n*60+Number(p),0);}
export function toBootstrap(state,group,rubricId) {
 const rubric=state.rubrics.find(r=>r.id===rubricId)||state.rubrics.at(-1),checklist=toChecklist(rubric),results={},appeals={},evaluations={};
 const conversations=state.conversations.filter(c=>!group||c.groupId===group);
 const dialogs=conversations.map(c=>{const raw=c.transcript.map(m=>[Number.isFinite(m.startSec)?m.startSec:relativeTime(m.timestamp,c.transcript[0].timestamp),m.speaker,m.text,m.timestamp]);return {id:c.conversation_id,hash:c.hash,seekable:c.transcript.every(m=>Number.isFinite(m.startSec)||/^\d+:\d{2}(?:\.\d{1,3})?$/.test(m.timestamp)),lang:c.language,channel:c.channel,audio:c.audio_url,raw,duration:c.durationSec||Math.max(...raw.map(m=>m[0]),1),operator:''};});
 for(const c of conversations){
  const e=state.evaluations.filter(e=>e.conversationId===c.conversation_id&&e.conversationHash===c.hash&&e.rubricId===rubric.id).at(-1);if(!e)continue;
  const dialog=dialogs.find(d=>d.id===c.conversation_id);
  dialog.grossAI=rubric.criteria.some(criterion=>criterion.type==='flag'&&e.answers.find(a=>a.criterionId===criterion.id)?.answer==='yes');
  dialog.grossFinal=rubric.criteria.some(criterion=>criterion.type==='flag'&&(e.reviewedAnswers||e.answers).find(a=>a.criterionId===criterion.id)?.answer==='yes');
  evaluations[c.conversation_id]=e.id;results[c.conversation_id]={};
  for(const a of e.answers){const criterion=checklist.criteria.find(x=>x.id===a.criterionId);if(!criterion)continue;
   const evidence=(a.evidenceIds||[]).map(id=>c.transcript.findIndex(m=>m.id===id)).filter(i=>i>=0);
   const range=a.checkedRange?[a.checkedRange.from,a.checkedRange.to].map(id=>c.transcript.findIndex(m=>m.id===id)):null;
   results[c.conversation_id][a.criterionId]={evaluationId:e.id,finalValue:value(e.reviewedAnswers?.find(x=>x.criterionId===a.criterionId)?.answer??a.answer),k:criterion.type,v:value(a.answer),why:a.explanation,na:a.explanation,evidence,range,ev:evidence.length?{m:evidence[0]}:null,sig:signature(criterion),at:e.createdAt,stub:false};
  }
  for(const a of state.appeals.filter(a=>a.evaluationId===e.id)){const original=e.answers.find(x=>x.criterionId===a.criterionId)?.answer;appeals[c.conversation_id+'|'+a.criterionId]={id:a.id,evaluationId:e.id,comment:a.comment,at:a.createdAt,dec:a.decision?{v:value(a.decision.answer),reason:a.decision.reason,at:a.decision.createdAt,kind:a.decision.answer===original?'confirmed':'changed'}:null};}
 }
 return {group,checklist,dialogs,results,appeals,evaluations,jobs:state.jobs.filter(j=>['queued','running'].includes(j.status)),rubricId:rubric.id};
}
export function createArchiveApi({fetcher=fetch,pause=ms=>new Promise(r=>setTimeout(r,ms)),onProgress=()=>{}}={}) {
 let current=null;
 async function request(path,body){const response=await fetcher(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);return data;}
 async function refresh(){return current=toBootstrap(await request('/api/state'),current.group,current.rubricId);}
 return async function api(method,path,body){
  if(path.startsWith('/api/bootstrap')){const params=new URL(path,'http://localhost').searchParams;const input=params.get('group');let state=await request('/api/state');const group=input||state.conversations[0]?.groupId||'DEV';
   if(!state.conversations.some(c=>c.groupId===group)){await request('/api/import',{groupId:group});state=await request('/api/state');}
   return current=toBootstrap(state,group,params.get('rubricId'));
  }
  if(path==='/api/checklist'){const rubric=await request('/api/rubrics',toRubric(body));current.rubricId=rubric.id;await refresh();return current.checklist;}
  if(path==='/api/evaluate'||path==='/api/batch'){
   const batch=path==='/api/batch';
   const rubricId=current.rubricId,group=current.group;let state=await request('/api/state');
   const ids=batch?body.dialogIds:[body.dialogId];
   for(const id of ids){if(body.hashes?.[id]&&state.conversations.find(c=>c.conversation_id===id)?.hash!==body.hashes[id])throw Error('Транскрипт изменился. Перезагрузите набор перед оценкой.');}
   let job=state.jobs.find(j=>j.rubricId===rubricId&&['queued','running'].includes(j.status)&&ids.every(id=>j.conversationIds.includes(id)));
   if(!job)job=await request('/api/jobs',{conversationIds:ids,rubricId});
   while(true){state=await request('/api/state');const progress=state.jobs.find(j=>j.id===job.id);if(!progress)throw Error('Задача проверки не найдена.');
    const result=progress.results.find(r=>r.conversationId===body.dialogId);if(batch?progress.status==='completed':result){const mapped=toBootstrap(state,group,rubricId);if(current.rubricId===rubricId)current=mapped;if(batch)return {...mapped,errors:progress.results.filter(r=>r.error)};if(result.error)throw Error(result.error);if(!mapped.results[body.dialogId])throw Error('Транскрипт изменился во время проверки. Перезагрузите набор.');return {results:mapped.results[body.dialogId],dialog:mapped.dialogs.find(d=>d.id===body.dialogId),errors:{},rubricId};}
    onProgress(progress);await pause(1800);
   }
  }
  if(path==='/api/appeals'){await refresh();const evaluationId=current.evaluations[body.dialogId];if(!evaluationId)throw Error('Нужна актуальная оценка диалога.');if(body.evaluationId!==evaluationId)throw Error('Оценка изменилась в другой вкладке. Перезагрузите диалог перед апелляцией.');await request('/api/appeals',{evaluationId,criterionId:body.criterionId,comment:body.comment});await refresh();return current.appeals[body.dialogId+'|'+body.criterionId];}
  if(path==='/api/appeals/decide'){await refresh();const appeal=current.appeals[body.dialogId+'|'+body.criterionId];if(!appeal)throw Error('Апелляция не найдена.');if(body.appealId!==appeal.id)throw Error('Апелляция изменилась. Перезагрузите диалог.');const criterion=current.checklist.criteria.find(c=>c.id===body.criterionId);const answer=body.v==='na'?'na':criterion.type==='scale'?Number(body.v):Number(body.v)===1?'yes':'no';await request(`/api/appeals/${encodeURIComponent(appeal.id)}/resolve`,{answer,reason:body.reason});await refresh();return current.appeals[body.dialogId+'|'+body.criterionId];}
  throw Error('Неизвестная операция интерфейса.');
 };
}
