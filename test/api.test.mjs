import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp, readJsonBody } from '../server/app.mjs';
import { Store } from '../server/store.mjs';

const sample={conversation_id:'test-a',language:'RU',channel:'agent chat',audio_url:null,transcript:[{speaker:'operator',timestamp:'00:00',text:'Здравствуйте! Меня зовут Анна. Чем помочь?'}]};
test('chunk boundary inside UTF8 character does not corrupt RU or KZ',async()=>{
 const input=Buffer.from(JSON.stringify({text:'Привет, қазақша әңгіме'}));const split=input.indexOf(Buffer.from('П'))+1;
 const chunks={async *[Symbol.asyncIterator](){yield input.subarray(0,split);yield input.subarray(split);}};
 assert.deepEqual(await readJsonBody(chunks),{text:'Привет, қазақша әңгіме'});
});
async function fixture(t,evaluator){
 mkdirSync(resolve('.local/tests'),{recursive:true});
 const dir=mkdtempSync(resolve('.local/tests/cqa-test-'));
 const app=createApp({dataFile:join(dir,'state.json'),evaluator:evaluator??(async(c,r)=>({answers:r.criteria.map(x=>({criterionId:x.id,answer:x.type==='scale'?x.scale.at(-1):x.type==='flag'?'no':'yes',explanation:'Тестовый ответ адаптера.',evidenceIds:['m1'],checkedRange:null})),usage:{}}))});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
 t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));rmSync(dir,{recursive:true,force:true});});
 const request=async(path,body)=>{const response=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
 return {app,request,base};
}
test('import/evaluate/appeal/decision preserves original and durable reviewed score',async t=>{
 const {app,request}=await fixture(t);assert.equal((await request('/api/import',{payload:[sample]})).status,200);
 const state=(await request('/api/state')).data;const rubricId=state.rubrics[0].id;
 const result=(await request('/api/evaluate',{conversationId:'test-a',rubricId})).data;assert.equal(result.originalScore.total,100);
 const appeal=(await request('/api/appeals',{evaluationId:result.id,criterionId:'c1',comment:'Нет представления в первом ответе.'})).data;
 const resolved=await request(`/api/appeals/${appeal.id}/resolve`,{answer:'no',reason:'Проверено человеком.'});
 assert.equal(resolved.data.evaluation.finalScore.total,90);assert.equal(resolved.data.evaluation.originalScore.total,100);
 assert.equal(app.store.read().evaluations[0].answers[0].answer,'yes');
 const reloaded=new Store(app.store.file);assert.equal(reloaded.read().evaluations[0].finalScore.total,90);assert.equal(reloaded.read().evaluations[0].originalScore.total,100);
 assert.equal((await request(`/api/appeals/${appeal.id}/resolve`,{answer:'yes',reason:'Повтор.'})).status,409);
});
test('new rubric uses fresh inference and past version remains unchanged',async t=>{
 let calls=0;const {request}=await fixture(t,async(c,r)=>{calls++;return {answers:r.criteria.map(x=>({criterionId:x.id,answer:x.type==='scale'?x.scale.at(-1):x.type==='flag'?'no':'yes',explanation:'Основание.',evidenceIds:['m1']}))};});
 await request('/api/import',{payload:[sample]});const original=(await request('/api/state')).data.rubrics[0];
 await request('/api/evaluate',{conversationId:'test-a',rubricId:original.id});
 const criteria=structuredClone(original.criteria);criteria[0].description='Новый критерий для проверки.';
 const newer=(await request('/api/rubrics',{name:'Изменённый',criteria})).data;
 await request('/api/evaluate',{conversationId:'test-a',rubricId:newer.id});assert.equal(calls,2);
 const state=(await request('/api/state')).data;assert.notEqual(state.rubrics[0].hash,newer.hash);assert.equal(state.evaluations.length,2);
});
test('invalid model scores and cross-origin mutation are rejected',async t=>{
 const {request,base}=await fixture(t,async()=>({answers:[]}));await request('/api/import',{payload:[sample]});
 const r=(await request('/api/state')).data.rubrics[0];assert.equal((await request('/api/evaluate',{conversationId:'test-a',rubricId:r.id})).status,502);
 const response=await fetch(base+'/api/import',{method:'POST',headers:{'content-type':'application/json','origin':'https://evil.example'},body:JSON.stringify({payload:[sample]})});assert.equal(response.status,403);
 assert.equal((await request('/api/state')).data.evaluations.length,0);
});
test('batch preserves success and records per-dialog failure',async t=>{
 const {request}=await fixture(t,async(c,r)=>{if(c.conversation_id==='bad')throw Error('Model timeout');return {answers:r.criteria.map(x=>({criterionId:x.id,answer:x.type==='scale'?x.scale.at(-1):x.type==='flag'?'no':'yes',explanation:'Основание.',evidenceIds:['m1']}))};});
 await request('/api/import',{payload:[sample,{...sample,conversation_id:'bad'}]});const r=(await request('/api/state')).data.rubrics[0];
 const job=(await request('/api/jobs',{conversationIds:['test-a','bad'],rubricId:r.id})).data;
 let state;for(let i=0;i<50;i++){state=(await request('/api/state')).data;if(state.jobs[0].status==='completed')break;await new Promise(resolve=>setTimeout(resolve,20));}
 assert.equal(state.jobs[0].id,job.id);assert.equal(state.jobs[0].results.length,2);assert.ok(state.jobs[0].results[0].evaluationId);assert.match(state.jobs[0].results[1].error,/timeout/);assert.equal(state.evaluations.length,1);
 assert.equal(state.jobs[0].model,state.settings.model);assert.equal(state.jobs[0].settings,undefined);
});
test('submission import validates incoming count before merging with old records',async t=>{
 const {request}=await fixture(t);const payload=Array.from({length:10},(_,i)=>({...sample,conversation_id:`prod-${i}`}));
 assert.equal((await request('/api/import',{groupId:'PROD',payload,submissionSplit:'prod'})).status,200);
 const response=await request('/api/import',{groupId:'PROD',payload:payload.slice(0,9).map(c=>({...c,transcript:[{...c.transcript[0],text:'Изменённый текст.'}]})),submissionSplit:'prod'});
 assert.equal(response.status,400);assert.equal((await request('/api/state')).data.conversations[0].transcript[0].text,sample.transcript[0].text);
});
test('reimport never changes historical transcript evidence',async t=>{
 const {request}=await fixture(t);await request('/api/import',{payload:[sample]});const rubric=(await request('/api/state')).data.rubrics[0];
 const evaluation=(await request('/api/evaluate',{conversationId:sample.conversation_id,rubricId:rubric.id})).data;
 await request('/api/import',{payload:[{...sample,transcript:[{...sample.transcript[0],text:'Другой диалог.'}]}]});
 const state=(await request('/api/state')).data;assert.equal(state.evaluations[0].conversationSnapshot.transcript[0].text,sample.transcript[0].text);assert.notEqual(state.conversations[0].hash,evaluation.conversationHash);
});
