import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewDefaultCriteria } from '../server/criterion-review.mjs';
import { defaultRubric } from '../server/rubric.mjs';

const settings={model:'local',ollamaUrl:'http://127.0.0.1:11434'};
const conversation={language:'RU',channel:'agent chat',transcript:[
  {id:'m1',speaker:'client',text:'Где отчёт?',timestamp:'00:00'},
  {id:'m2',speaker:'operator',text:'Здравствуйте, я Анна. Откройте отчёты.',timestamp:'00:10'},
  {id:'m3',speaker:'client',text:'Спасибо.',timestamp:'00:20'}
]};
const facts={
 c1:{greeted:true,introduced:true},
 c2:{dataAlreadySufficient:true,missingDetailsClarifiedBeforeAdvice:false},
 c4:{noRequestWasEverStated:false,coverage:'complete'}
};
function transport(overrides={},requests=[]){return async(url,options)=>{
 const request=JSON.parse(options.body);requests.push({url:String(url),request});
 const props=request.format.properties;
 const id='greeted' in props?'c1':'dataAlreadySufficient' in props?'c2':'c4';
 return new Response(JSON.stringify({done_reason:'stop',message:{content:JSON.stringify({observation:'Произвольная модельная формулировка.',evidenceIds:['m2'],...facts[id],...overrides[id]})},prompt_eval_count:100,eval_count:20,total_duration:1234}));
};}
function only(id){const r=defaultRubric();r.criteria=r.criteria.filter(c=>c.id===id);return r;}

test('focused review honors the configured context without truncating the transcript',async()=>{
 const previous=process.env.OLLAMA_CONTEXT;process.env.OLLAMA_CONTEXT='32768';
 try {
  const requests=[];await reviewDefaultCriteria(conversation,defaultRubric(),settings,{fetcher:transport({},requests)});
  assert.equal(requests.length,3);
  for(const {request} of requests){assert.equal(request.options.num_ctx,32768);assert.equal(request.truncate,false);assert.equal(request.shift,false);assert.deepEqual(JSON.parse(request.messages[1].content).transcript,conversation.transcript);}
 }finally{if(previous===undefined)delete process.env.OLLAMA_CONTEXT;else process.env.OLLAMA_CONTEXT=previous;}
});

test('reviews only three matching semantics and carries full input, evidence, deterministic explanations and usage',async()=>{
 const requests=[];const result=await reviewDefaultCriteria(conversation,defaultRubric(),settings,{fetcher:transport({},requests)});
 assert.equal(result.mode,'focused-default-v1');
 assert.deepEqual(result.answers.map(a=>[a.criterionId,a.answer]),[['c1','yes'],['c2','na'],['c4',20]]);
 for(const a of result.answers){assert.deepEqual(a.checkedRange,{from:'m1',to:'m3'});assert.doesNotMatch(a.explanation,/Произвольная/);}
 assert.match(result.answers[1].explanation,/достаточно|хватало/i);
 assert.deepEqual(result.stages.map(s=>s.criterionId),['c1','c2','c4']);
 assert.deepEqual(result.stages[0].usage,{promptTokens:100,outputTokens:20,totalDurationNs:1234});
 assert.ok(result.stages.every(s=>Number.isFinite(s.durationMs)&&s.durationMs>=0));
 for(const {url,request} of requests){assert.equal(url,'http://127.0.0.1:11434/api/chat');assert.equal(request.think,false);assert.equal(request.truncate,false);assert.equal(request.shift,false);assert.equal(request.options.num_predict,450);assert.equal(request.options.temperature,0);assert.equal(request.options.seed,42);assert.equal(request.options.num_ctx,16384);assert.deepEqual(JSON.parse(request.messages[1].content).transcript,conversation.transcript);}
});

test('semantic edits skip only edited criterion; weight/section and equivalent renamed IDs still review',async()=>{
 const r=defaultRubric();r.criteria[0].description='Оператор предложил обратный звонок.';r.criteria[1].weight=99;r.criteria[1].section='Новая секция';r.criteria[3].id='consultation';r.criteria.push({...r.criteria[0],id:'custom',title:'Другое'});
 const result=await reviewDefaultCriteria(conversation,r,settings,{fetcher:transport()});
 assert.deepEqual(result.answers.map(a=>a.criterionId),['c2','consultation']);
 for(const field of ['title','description','type','scale','allowNA','naRule']){
  const rubric=only('c1');rubric.criteria[0][field]=field==='scale'?[0,1]:field==='allowNA'?true:'changed';
  const result=await reviewDefaultCriteria(conversation,rubric,settings,{fetcher:()=>{throw Error('must skip');}});assert.deepEqual(result.answers,[],field);
 }
});

test('maps factual predicates to exact rubric answers without using observation text',async()=>{
 const cases=[
 ['c1',{greeted:false,introduced:true},'no'],['c1',{greeted:true,introduced:false},'no'],['c1',{greeted:false,introduced:false},'no'],
 ['c2',{dataAlreadySufficient:true,missingDetailsClarifiedBeforeAdvice:true},'na'],
 ['c2',{dataAlreadySufficient:false,missingDetailsClarifiedBeforeAdvice:true},'yes'],
 ['c2',{dataAlreadySufficient:false,missingDetailsClarifiedBeforeAdvice:false},'no'],
 ['c4',{noRequestWasEverStated:true,coverage:'complete'},'na'],
 ...Object.entries({complete:20,secondary_omission:15,substantial_omission:10,vague_hint:5,none_or_wrong:0}).map(([coverage,answer])=>['c4',{noRequestWasEverStated:false,coverage},answer])];
 for(const [id,predicates,answer] of cases){const result=await reviewDefaultCriteria(conversation,only(id),settings,{fetcher:transport({[id]:{...predicates,observation:'Противоречивое обоснование: всё неверно.'}})});assert.equal(result.answers[0].answer,answer,`${id}: ${JSON.stringify(predicates)}`);assert.doesNotMatch(result.answers[0].explanation,/Противоречивое/);}
});

test('invalid evidence and malformed or missing predicates reject rather than fabricate decisions',async()=>{
 const bad=[['c1',{evidenceIds:['m1']}],['c1',{evidenceIds:['unknown']}],['c2',{evidenceIds:[]}],['c2',{dataAlreadySufficient:'false'}],['c2',{missingDetailsClarifiedBeforeAdvice:undefined}],['c4',{coverage:'unsupported'}],['c4',{noRequestWasEverStated:null}],['c4',{observation:''}]];
 for(const [id,value] of bad)await assert.rejects(()=>reviewDefaultCriteria(conversation,only(id),settings,{fetcher:transport({[id]:value})}),/провер|критери|реплик|доказатель|поле/i);
});

test('rejects incomplete responses, invalid JSON, HTTP errors and network failure without retry',async()=>{
 for(const payload of [{done_reason:'length',message:{content:'{}'}},{done_reason:'stop',message:{content:'not json'}}])await assert.rejects(()=>reviewDefaultCriteria(conversation,only('c4'),settings,{fetcher:async()=>new Response(JSON.stringify(payload))}),/провер|критери|JSON|лимит/i);
 await assert.rejects(()=>reviewDefaultCriteria(conversation,only('c4'),settings,{fetcher:async()=>new Response('{}',{status:503})}),/503/);
 let count=0;await assert.rejects(()=>reviewDefaultCriteria(conversation,only('c4'),settings,{fetcher:async()=>{count++;throw Error('offline');}}),/провер|подключ|ответ/i);assert.equal(count,1);
});

test('rejects remote endpoints/cloud names before sending conversation and skips c1 without an operator',async()=>{
 for(const config of [{...settings,ollamaUrl:'https://remote.example'},{...settings,model:'model-cloud'},{...settings,ollamaUrl:'http://localhost@remote.example'}])await assert.rejects(()=>reviewDefaultCriteria(conversation,defaultRubric(),config,{fetcher:()=>{throw Error('must not send');}}),/локаль|облач/i);
 const result=await reviewDefaultCriteria({...conversation,transcript:[conversation.transcript[0]]},only('c1'),settings,{fetcher:()=>{throw Error('must skip');}});assert.deepEqual(result.answers,[]);
});
