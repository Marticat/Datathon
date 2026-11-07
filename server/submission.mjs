import { defaultRubric } from './rubric.mjs';
import { calculateScore, hash, validateAnswers } from './domain.mjs';

export const OFFICIAL_IDS=['contact','discovery','identification','consultation','empathy','dialogue','closure','critical'];
const official=defaultRubric();
const officialHash=hash(official.criteria);
const requireThat=(condition,message)=>{if(!condition)throw Object.assign(Error(message),{status:400});};
export function officialSubmissionRubric(state) {
 const rubric=state.rubrics.find(r=>hash(r.criteria)===officialHash);
 requireThat(rubric,'Официальный чек-лист не найден. Изменённые правила нельзя сдавать как официальный результат.');
 return rubric;
}
export function submissionConversations(state,split,groupId) {
 requireThat(['dev','prod'].includes(split),'Набор должен быть dev или prod.');
 const conversations=state.conversations.filter(c=>c.groupId===groupId);
 requireThat(conversations.length===(split==='dev'?65:10),`В ${split} должно быть ровно ${split==='dev'?65:10} диалогов; найдено ${conversations.length}.`);
 requireThat(new Set(conversations.map(c=>c.conversation_id)).size===conversations.length,'Повторяющиеся conversation_id.');
 requireThat(conversations.filter(c=>c.channel==='agent chat').length===(split==='dev'?60:10)&&conversations.filter(c=>c.channel==='voice call').length===(split==='dev'?5:0),'Неверный состав набора: DEV — 60 чатов и 5 звонков, PROD — 10 чатов.');
 return conversations;
}
export function buildSubmission(state,{split,groupId=split.toUpperCase(),teamName,jobId}={}) {
 requireThat(typeof teamName==='string'&&teamName.trim().length>0,'Укажите team_name — название команды.');
 const conversations=submissionConversations(state,split,groupId);
 const rubric=officialSubmissionRubric(state);
 const job=jobId?state.jobs.find(j=>j.id===jobId):null;
 if(jobId){
  requireThat(job?.status==='completed','Указанная задача не найдена или ещё не завершена.');
  requireThat(job.rubricId===rubric.id,'Задача использует другой чек-лист.');
  requireThat(job.conversationIds.length===conversations.length&&conversations.every(c=>job.conversationIds.includes(c.conversation_id)),'Состав задачи не совпадает с набором для сдачи.');
 }
 const models=new Set();
 const results=conversations.map(conversation=>{
  const id=conversation.conversation_id;
  try {
   const outcome=job?.results.find(r=>r.conversationId===id);
   if(job)requireThat(outcome&&!outcome.error,outcome?.error||'В задаче отсутствует результат диалога.');
   const evaluation=job?state.evaluations.find(e=>e.id===outcome.evaluationId):state.evaluations.findLast(e=>e.conversationId===id&&e.conversationHash===conversation.hash&&e.rubricHash===officialHash);
   requireThat(evaluation,'Актуальная AI-оценка по официальному чек-листу отсутствует.');
   requireThat(evaluation.conversationId===id&&evaluation.conversationHash===conversation.hash,'Исходный диалог изменён после оценки.');
   requireThat(evaluation.rubricHash===officialHash,'Оценка выполнена по изменённому чек-листу.');
   requireThat(typeof evaluation.model==='string'&&evaluation.model.trim(),'Не сохранено название фактически использованной модели.');
   const answers=validateAnswers(rubric,conversation,evaluation.answers);
   const score=calculateScore(rubric,answers);
   const criteria=answers.map((answer,i)=>{
    const ids=conversation.transcript.map(m=>m.id);
    const turns=answer.evidenceIds.map(id=>ids.indexOf(id)+1);
    if(!turns.length&&answer.checkedRange){for(let n=ids.indexOf(answer.checkedRange.from)+1;n<=ids.indexOf(answer.checkedRange.to)+1;n++)turns.push(n);}
    return {criterion_id:OFFICIAL_IDS[i],value:answer.answer==='na'?null:answer.answer==='yes'?true:answer.answer==='no'?false:answer.answer,rationale:answer.explanation,evidence_turns:[...new Set(turns)].sort((a,b)=>a-b)};
   });
   models.add(evaluation.model);
   return {conversation_id:id,status:'ok',criteria,score:{final_score:score.total,critical_flag:score.grossViolation}};
  } catch(error) {
   // Do not leak network URLs, signed query parameters or raw responses into Git.
   const reason=String(error.message).replace(/https?:\/\/\S+/gi,'[адрес скрыт]').slice(0,500);
   return {conversation_id:id,status:'error',criteria:[],score:null,error:reason};
  }
 });
 const attemptedModel=job?.model||job?.settings?.model;
 if(attemptedModel)models.add(attemptedModel);
 requireThat(models.size>0,'Неизвестна фактически использованная модель. Запустите оценку набора и экспортируйте её задачу.');
 const document={schema_version:'1.0',team_name:teamName.trim(),model:{mode:'local',name:[...models].join(', ')},results};
 validateSubmission(document,conversations,split);
 return document;
}
export function validateSubmission(document,conversations,split) {
 requireThat(document?.schema_version==='1.0','Неверная schema_version.');
 requireThat(typeof document.team_name==='string'&&document.team_name.trim(),'Отсутствует team_name.');
 requireThat(['local','external_api','hybrid'].includes(document.model?.mode)&&typeof document.model?.name==='string'&&document.model.name.trim(),'Некорректное описание модели.');
 requireThat(Array.isArray(document.results)&&document.results.length===(split==='dev'?65:10)&&document.results.length===conversations.length,'Неверное число результатов.');
 const seen=new Set();
 for(const result of document.results){
  const conversation=conversations.find(c=>c.conversation_id===result.conversation_id);
  requireThat(conversation&&!seen.has(result.conversation_id),'Пропущенный, неизвестный или повторный conversation_id.');seen.add(result.conversation_id);
  if(result.status==='error'){
   requireThat(Array.isArray(result.criteria)&&result.criteria.length===0&&result.score===null&&typeof result.error==='string'&&result.error.trim(),'Некорректная запись ошибки.');continue;
  }
  requireThat(result.status==='ok'&&Array.isArray(result.criteria)&&result.criteria.length===8,'Для ok нужны все 8 критериев.');
  const answers=OFFICIAL_IDS.map((id,i)=>{
   const rows=result.criteria.filter(c=>c.criterion_id===id);requireThat(rows.length===1,'Неизвестный или повторный criterion_id.');const row=rows[0];
   requireThat(row.value===null||typeof row.value==='boolean'||typeof row.value==='number','Неверный тип value.');
   const criterion=official.criteria[i];
   requireThat(row.value===null?criterion.allowNA:criterion.type==='scale'?criterion.scale.includes(row.value):typeof row.value==='boolean','Недопустимое значение критерия.');
   requireThat(typeof row.rationale==='string'&&row.rationale.trim(),'Необходимо обоснование.');
   requireThat(Array.isArray(row.evidence_turns)&&row.evidence_turns.length>0&&new Set(row.evidence_turns).size===row.evidence_turns.length&&row.evidence_turns.every(n=>Number.isInteger(n)&&n>=1&&n<=conversation.transcript.length),'Недопустимый номер исходной реплики.');
   return {criterionId:criterion.id,answer:row.value===null?'na':row.value===true?'yes':row.value===false?'no':row.value};
  });
  const expected=calculateScore(official,answers);
  requireThat(result.score?.final_score===expected.total&&typeof result.score.final_score==='number'&&result.score.final_score>=0&&result.score.final_score<=100,'Итог не соответствует официальной формуле.');
  requireThat(result.score.critical_flag===expected.grossViolation,'critical_flag не совпадает с critical.');
 }
 return true;
}
