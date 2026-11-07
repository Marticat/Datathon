import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultRubric } from '../server/rubric.mjs';
import { calculateScore, validateRubric, normalizeConversations, validateAnswers } from '../server/domain.mjs';

const rubric=defaultRubric();
const answers=(values=['yes','na','na',15,'yes',7,'yes','no'])=>rubric.criteria.map((c,i)=>({criterionId:c.id,answer:values[i],explanation:'Проверено по диалогу.',evidenceIds:['m1'],checkedRange:null}));
const conversation=()=>normalizeConversations([{conversation_id:'a',language:'RU',channel:'agent chat',audio_url:null,transcript:[{speaker:'operator',timestamp:'00:00',text:'Здравствуйте, я Анна.'}]}])[0];
test('weighted score normalizes NA to 85.38 with c6 seven giving 10.5 raw points',()=>{
 const score=calculateScore(rubric,answers()); assert.equal(score.total,85.38); assert.equal(score.applicableWeight,65); assert.equal(score.grossViolation,false);
 assert.ok(Math.abs(score.criteria.reduce((a,c)=>a+c.effectiveWeight,0)-100)<1e-8);
});
test('gross violation is a separate flag and never zeros the total',()=>{
 const a=answers();a[7].answer='yes';assert.equal(calculateScore(rubric,a).total,85.38);assert.equal(calculateScore(rubric,a).grossViolation,true);
});
test('rejects illegal NA, arbitrary numeric step, duplicate and missing criterion',()=>{
 const a=answers();a[0].answer='na';assert.throws(()=>calculateScore(rubric,a),/N\/A/);
 a[0].answer='yes';a[5].answer=8;assert.throws(()=>calculateScore(rubric,a),/шкал/);
 assert.throws(()=>calculateScore(rubric,answers().slice(1)),/критери/);
 const dup=answers();dup[1]=dup[0];assert.throws(()=>calculateScore(rubric,dup),/критери/);
});
test('all inapplicable weighted criteria on custom rubric produce null total',()=>{
 const r={criteria:[{id:'custom',type:'binary',weight:5,allowNA:true,section:'A'}]};assert.equal(calculateScore(r,[{criterionId:'custom',answer:'na'}]).total,null);
});
test('evidence must exist and omitted action range must be ordered',()=>{
 const a=answers();assert.equal(validateAnswers(rubric,conversation(),a).length,8);
 a[0].evidenceIds=['made-up'];assert.throws(()=>validateAnswers(rubric,conversation(),a),/реплик/);
 a[0].evidenceIds=[];a[0].checkedRange=null;assert.throws(()=>validateAnswers(rubric,conversation(),a),/доказатель/);
});
test('import assigns stable message IDs and preserves raw timestamps, validates before mutation',()=>{
 const c=conversation();assert.equal(c.transcript[0].id,'m1');assert.equal(c.transcript[0].timestamp,'00:00');assert.ok(c.hash);
 assert.throws(()=>normalizeConversations([{...c,language:'xx'}]),/язык/);
 assert.throws(()=>normalizeConversations([{...c,audio_url:'javascript:alert(1)'}]),/аудио/);
 assert.throws(()=>normalizeConversations([c,c]),/повтор/);
});
test('rubric accepts new semantic criterion but rejects duplicate IDs and bad scales',()=>{
 assert.equal(validateRubric(rubric).criteria.length,8);
 const copy=structuredClone(rubric);copy.criteria[0].id='c2';assert.throws(()=>validateRubric(copy),/ID/);
 const scale=structuredClone(rubric);scale.criteria[5].scale=[0,0];assert.throws(()=>validateRubric(scale),/шкал/);
});
