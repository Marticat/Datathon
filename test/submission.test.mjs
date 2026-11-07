import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultRubric } from '../server/rubric.mjs';
import { hash, normalizeConversations } from '../server/domain.mjs';
import { buildSubmission, validateSubmission } from '../server/submission.mjs';

function fixture(split='prod') {
 const rubric=defaultRubric();rubric.hash=hash(rubric.criteria);
 const conversations=normalizeConversations(Array.from({length:split==='prod'?10:65},(_,i)=>({conversation_id:`source-${i}`,language:'RU',channel:i>=60?'voice call':'agent chat',transcript:['client','bot','system','operator'].map((speaker,j)=>({speaker,timestamp:`00:0${j}`,text:'Исходная реплика.'}))})),split.toUpperCase());
 const evaluations=conversations.map(c=>({id:`ev-${c.conversation_id}`,conversationId:c.conversation_id,conversationHash:c.hash,rubricId:rubric.id,rubricHash:rubric.hash,model:'actual-local-model',answers:['yes','na','na',15,'yes',7,'yes','no'].map((answer,i)=>({criterionId:`c${i+1}`,answer,explanation:'Обоснование по исходным репликам.',evidenceIds:i===7?[]:['m4'],checkedRange:i===7?{from:'m1',to:'m4'}:null})),reviewedAnswers:[],finalScore:{total:0}}));
 return {conversations,evaluations,rubrics:[rubric],jobs:[],settings:{model:'configured-but-unused'}};
}
const options={split:'prod',groupId:'PROD',teamName:'orleugpt'};
test('official submission uses original AI values, original turn indices and actual model',()=>{
 const result=buildSubmission(fixture(),options);
 assert.equal(result.team_name,'orleugpt');assert.equal(result.schema_version,'1.0');assert.equal(result.model.name,'actual-local-model');
 assert.deepEqual(result.results[0].score,{final_score:85.38,critical_flag:false});
 assert.deepEqual(result.results[0].criteria.map(c=>c.value),[true,null,null,15,true,7,true,false]);
 assert.deepEqual(result.results[0].criteria.map(c=>c.criterion_id),['contact','discovery','identification','consultation','empathy','dialogue','closure','critical']);
 assert.deepEqual(result.results[0].criteria[0].evidence_turns,[4]);assert.deepEqual(result.results[0].criteria[7].evidence_turns,[1,2,3,4]);
 assert.equal(result.results[0].conversation_id,'source-0');assert.ok(!JSON.stringify(result).includes('transcript'));
});
test('missing, stale, changed rubric and invalid evidence are errors, never fabricated zeros',()=>{
 const state=fixture();state.evaluations.shift();state.evaluations[0].conversationHash='stale';state.evaluations[1].rubricHash='custom';state.evaluations[2].answers[0].evidenceIds=['m99'];
 const output=buildSubmission(state,options);assert.equal(output.results.length,10);
 for(const result of output.results.slice(0,4)){assert.equal(result.status,'error');assert.deepEqual(result.criteria,[]);assert.equal(result.score,null);assert.ok(result.error);}
});
test('counts, duplicate IDs, channel mix and team name are checked before writing',()=>{
 for(const mutation of [s=>s.conversations.pop(),s=>s.conversations[1].conversation_id=s.conversations[0].conversation_id,s=>s.conversations[0].channel='voice call']){
  const state=fixture();mutation(state);assert.throws(()=>buildSubmission(state,options));
 }
 assert.throws(()=>buildSubmission(fixture(),{...options,teamName:''}));
 assert.equal(buildSubmission(fixture('dev'),{...options,split:'dev',groupId:'DEV'}).results.length,65);
});
test('explicit completed batch never falls back to an old success when the new attempt failed',()=>{
 const state=fixture();state.jobs.push({id:'batch',status:'completed',conversationIds:state.conversations.map(c=>c.conversation_id),rubricId:state.rubrics[0].id,results:state.evaluations.map(e=>({conversationId:e.conversationId,evaluationId:e.id}))});
 state.jobs[0].results[0]={conversationId:'source-0',error:'Model timeout'};
 assert.equal(buildSubmission(state,{...options,jobId:'batch'}).results[0].status,'error');
 state.jobs[0].status='running';assert.throws(()=>buildSubmission(state,{...options,jobId:'batch'}),/заверш/);
});
test('validation rejects wrong types, wrong totals, duplicates and invalid evidence',()=>{
 const state=fixture();const output=buildSubmission(state,options);
 for(const mutate of [o=>o.results[0].criteria[0].value='true',o=>o.results[0].score.final_score=85,o=>o.results[0].score.critical_flag=true,o=>o.results[0].criteria[0].evidence_turns=[0],o=>o.results[0].criteria.push(o.results[0].criteria[0]),o=>o.results[0].conversation_id='not-in-source']){
  const broken=structuredClone(output);mutate(broken);assert.throws(()=>validateSubmission(broken,state.conversations,'prod'));
 }
});
test('all-error batch reports the attempted model, never the newly selected one',()=>{
 const state=fixture();state.jobs.push({id:'failed',model:'actually-attempted',status:'completed',conversationIds:state.conversations.map(c=>c.conversation_id),rubricId:state.rubrics[0].id,results:state.conversations.map(c=>({conversationId:c.conversation_id,error:'Model timeout'}))});
 assert.equal(buildSubmission(state,{...options,jobId:'failed'}).model.name,'actually-attempted');
 delete state.jobs[0].model;assert.throws(()=>buildSubmission(state,{...options,jobId:'failed'}),/модел/);
});
