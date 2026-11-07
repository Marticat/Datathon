import { createHash } from 'node:crypto';
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = text => {const e=new Error(text);e.status=400;throw e;};
export function text(value,name,max=10000) {if(typeof value!=='string'||!value.trim()||value.length>max)fail(`Некорректное поле: ${name}`);return value.trim();}
export function validateRubric(input) {
  if(!input||!Array.isArray(input.criteria)||input.criteria.length<1||input.criteria.length>30)fail('Нужно от 1 до 30 критериев.');
  const ids=new Set();
  const criteria=input.criteria.map(c=>{
    const id=text(c.id,'ID',60);if(!/^[a-zA-Z0-9_-]+$/.test(id)||ids.has(id))fail('ID критериев должны быть уникальными: буквы, цифры, _ и -.');ids.add(id);
    if(!['binary','scale','flag'].includes(c.type))fail('Неизвестный тип критерия.');
    if(typeof c.weight!=='number'||!Number.isFinite(c.weight)||c.weight<0||c.weight>1000||(c.type==='flag'&&c.weight!==0))fail('Некорректный вес: флаг должен иметь вес 0.');
    let scale=[];
    if(c.type==='scale') {scale=c.scale;if(!Array.isArray(scale)||scale.length<2||scale.length>30||scale.some((v,i)=>typeof v!=='number'||!Number.isFinite(v)||v<0||(i>0&&v<=scale[i-1]))||scale[0]!==0||scale.at(-1)<=0)fail('Ступени шкалы должны начинаться с 0 и строго возрастать.');}
    if(typeof c.allowNA!=='boolean')fail('Укажите доступность N/A.');
    return {id,title:text(c.title,'Название',200),section:text(c.section||'Общее','Секция',200),description:text(c.description,'Правило',8000),type:c.type,weight:c.weight,scale,allowNA:c.allowNA,naRule:c.allowNA?text(c.naRule,'Условие N/A',3000):''};
  });
  if(!criteria.some(c=>c.weight>0))fail('Нужен хотя бы один критерий с положительным весом.');
  return {name:text(input.name,'Название чек-листа',200),criteria};
}
export function normalizeConversations(input,groupId='UPLOAD') {
  const records=Array.isArray(input)?input:input?.data?.records??input?.records;
  if(input?.isSuccess===false||!Array.isArray(records)||records.length<1||records.length>1000)fail('Ожидается массив диалогов или ответ API с data.records.');
  const ids=new Set();
  return records.map(c=>{
    const id=text(c.conversation_id,'conversation_id',150);if(ids.has(id))fail('ID диалогов не должны повторяться.');ids.add(id);
    if(!['RU','KZ','EN'].includes(c.language))fail('Неподдерживаемый язык. Допустимы RU, KZ, EN.');
    if(!['agent chat','voice call'].includes(c.channel))fail('Неизвестный канал.');
    if(!Array.isArray(c.transcript)||!c.transcript.length||c.transcript.length>3000)fail('Транскрипт должен содержать реплики.');
    const transcript=c.transcript.map((m,i)=>{
      if(!['client','operator','bot','system'].includes(m.speaker))fail('Неизвестная роль реплики.');
      return {id:`m${i+1}`,speaker:m.speaker,timestamp:text(m.timestamp,'timestamp',100),text:text(m.text,'Текст реплики',30000)};
    });
    let audio_url=c.audio_url||null;
    if(audio_url) {try{const u=new URL(audio_url);if(!['http:','https:'].includes(u.protocol))throw Error();}catch{fail('Некорректная ссылка на аудио.');}}
    const normalized={conversation_id:id,channel:c.channel,language:c.language,transcript,audio_url};
    return {...normalized,groupId,hash:hash(normalized)};
  });
}
export function validateAnswer(c,answer) {
  if(answer==='na') {if(!c.allowNA)fail(`N/A запрещён: ${c.title||c.id}`);return;}
  if(c.type==='scale') {if(!c.scale.includes(answer))fail(`Недопустимая ступень шкалы: ${c.title||c.id}`);}
  else if(!['yes','no'].includes(answer))fail(`Недопустимый ответ: ${c.title||c.id}`);
}
function answerMap(rubric,answers) {
  if(!Array.isArray(answers)||answers.length!==rubric.criteria.length)fail('Необходимо оценить все критерии.');
  const mapped=new Map();
  for(const a of answers) {if(!a||mapped.has(a.criterionId)||!rubric.criteria.some(c=>c.id===a.criterionId))fail('Неизвестный или повторный критерий.');mapped.set(a.criterionId,a);}
  return mapped;
}
export function validateAnswers(rubric,conversation,answers) {
  const mapped=answerMap(rubric,answers);const ids=conversation.transcript.map(m=>m.id);
  return rubric.criteria.map(c=>{
    const a=mapped.get(c.id);validateAnswer(c,a.answer);const explanation=text(a.explanation,'Обоснование',6000);
    if(!Array.isArray(a.evidenceIds)||a.evidenceIds.some(id=>typeof id!=='string'||!ids.includes(id)))fail('Доказательство ссылается на неизвестную реплику.');
    let checkedRange=null;
    if(a.checkedRange) {const {from,to}=a.checkedRange;if(!ids.includes(from)||!ids.includes(to)||ids.indexOf(from)>ids.indexOf(to))fail('Некорректный диапазон реплик.');checkedRange={from,to};}
    if(!a.evidenceIds.length&&!checkedRange)fail('Необходимо доказательство или проверенный диапазон.');
    return {criterionId:c.id,answer:a.answer,explanation,evidenceIds:[...new Set(a.evidenceIds)],checkedRange};
  });
}
export function calculateScore(rubric,answers) {
  const mapped=answerMap(rubric,answers);
  let applicableWeight=0,earned=0,grossViolation=false;
  const criteria=rubric.criteria.map(c=>{
    const a=mapped.get(c.id);if(!a)fail('Необходимо оценить все критерии.');validateAnswer(c,a.answer);
    if(c.type==='flag') {if(a.answer==='yes')grossViolation=true;return {criterionId:c.id,answer:a.answer,weight:0,normalized:null,contribution:0,effectiveWeight:0};}
    if(a.answer==='na')return {criterionId:c.id,answer:'na',weight:c.weight,normalized:null,contribution:0,effectiveWeight:0};
    const normalized=c.type==='scale'?a.answer/c.scale.at(-1):(a.answer==='yes'?1:0);
    applicableWeight+=c.weight;earned+=c.weight*normalized;
    return {criterionId:c.id,answer:a.answer,weight:c.weight,normalized,contribution:0,effectiveWeight:0};
  });
  const sections=new Map();
  for(let i=0;i<criteria.length;i++) {const row=criteria[i],c=rubric.criteria[i];if(row.normalized!==null&&applicableWeight>0){row.effectiveWeight=100*c.weight/applicableWeight;row.contribution=row.effectiveWeight*row.normalized;}
    if(c.type!=='flag'){const s=sections.get(c.section)||{name:c.section,earned:0,possible:0};s.earned+=row.contribution;s.possible+=row.effectiveWeight;sections.set(c.section,s);}}
  return {total:applicableWeight?Math.round((100*earned/applicableWeight+Number.EPSILON)*100)/100:null,grossViolation,applicableWeight,criteria,sections:[...sections.values()]};
}
