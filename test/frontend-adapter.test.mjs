import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultRubric } from '../server/rubric.mjs';
import { toChecklist, toRubric, toBootstrap, createArchiveApi, filterDialogs, listChecklists } from '../public/cqa-api.js';
test('new frontend preserves official scales, NA rules and separate gross flag',()=>{
 const r=defaultRubric(),c=toChecklist(r),back=toRubric(c);
 assert.deepEqual(back.criteria,r.criteria);assert.deepEqual(c.criteria[5].steps,[10,7,4,0]);assert.equal(c.criteria[7].gross,true);
});
const conversation={conversation_id:'a',hash:'current',groupId:'DEV',language:'KZ',channel:'voice call',audio_url:null,transcript:[{id:'m1',speaker:'operator',timestamp:'2026-01-01T10:00:00Z',text:'Сәлем!'},{id:'m2',speaker:'client',timestamp:'2026-01-01T10:00:10Z',text:'Рақмет!'}]};
function state(){return {conversations:[conversation],rubrics:[defaultRubric()],evaluations:[],appeals:[],jobs:[]};}

test('fresh empty archive opens without implicitly importing an unconfigured dataset',async()=>{
 const s=state();s.conversations=[];const paths=[];
 const api=createArchiveApi({fetcher:async path=>{paths.push(path);return new Response(JSON.stringify(path==='/api/state'?s:{error:'Dataset source is not configured'}),{status:path==='/api/state'?200:400});}});
 const result=await api('GET','/api/bootstrap');
 assert.deepEqual(result.dialogs,[]);assert.equal(result.checklist.version,1);assert.deepEqual(paths,['/api/state']);
});

test('bootstrap exposes imported groups and opens an external group without fetching organizer data',async()=>{
 const s=state();s.conversations.push({...conversation,conversation_id:'external',groupId:'EXTERNAL-ABCD'});const paths=[];
 const api=createArchiveApi({fetcher:async path=>{paths.push(path);return new Response(JSON.stringify(s));}});
 const result=await api('GET','/api/bootstrap?group=EXTERNAL-ABCD');
 assert.deepEqual(result.groups,['DEV','EXTERNAL-ABCD']);assert.deepEqual(result.dialogs.map(d=>d.id),['external']);assert.deepEqual(paths,['/api/state']);
});
test('bootstrap never reuses another rubric version or historical transcript',()=>{
 const s=state();s.evaluations=[{id:'old',conversationId:'a',rubricId:s.rubrics[0].id,conversationHash:'old',answers:[]}];
 const b=toBootstrap(s,'DEV');assert.deepEqual(b.results,{});assert.equal(b.dialogs[0].raw[1][0],10);assert.equal(b.dialogs[0].raw[1][3],conversation.transcript[1].timestamp);
});
test('all evidence IDs and evaluation identity survive conversion',()=>{
 const s=state();s.evaluations=[{id:'e1',conversationId:'a',rubricId:s.rubrics[0].id,conversationHash:'current',createdAt:'now',answers:[{criterionId:'c1',answer:'yes',explanation:'Причина',evidenceIds:['m1','m2'],checkedRange:null}]}];
 s.appeals=[{id:'ap1',evaluationId:'e1',criterionId:'c1',comment:'Спор',createdAt:'now',status:'resolved',decision:{answer:'no',reason:'Решение',createdAt:'now'}}];
 const b=toBootstrap(s,'DEV');assert.equal(b.results.a.c1.v,1);assert.deepEqual(b.results.a.c1.evidence,[0,1]);assert.equal(b.appeals['a|c1'].id,'ap1');assert.equal(b.appeals['a|c1'].dec.v,0);
});
test('single evaluation queues durable server job and maps original answers',async()=>{
 const s=state();let queued=false;const seen=[];
 const api=createArchiveApi({pause:async()=>{},fetcher:async(path,options={})=>{
  seen.push(path);let body;
  if(path==='/api/jobs'){queued=true;body={id:'j1'};}
  else {if(queued){s.jobs=[{id:'j1',status:'completed',results:[{conversationId:'a',evaluationId:'e1'}]}];s.evaluations=[{id:'e1',conversationId:'a',conversationHash:'current',rubricId:s.rubrics[0].id,answers:[{criterionId:'c6',answer:7,explanation:'Ясно',evidenceIds:['m1']}]}];}body=s;}
  return new Response(JSON.stringify(body));
 }});
 await api('GET','/api/bootstrap?group=DEV');const result=await api('POST','/api/evaluate',{dialogId:'a'});
 assert.equal(result.results.c6.v,7);assert.ok(seen.includes('/api/jobs'));assert.ok(!seen.includes('/api/evaluate'));
});
test('another open appeal preserves the previously reviewed answer',()=>{
 const s=state();s.evaluations=[{id:'e',conversationId:'a',conversationHash:'current',rubricId:s.rubrics[0].id,answers:[{criterionId:'c1',answer:'yes',explanation:'Original',evidenceIds:['m1']}],reviewedAnswers:[{criterionId:'c1',answer:'no'}]}];
 s.appeals=[{id:'open',evaluationId:'e',criterionId:'c1',status:'open',comment:'Again'}];
 const b=toBootstrap(s,'DEV');assert.equal(b.results.a.c1.v,1);assert.equal(b.results.a.c1.finalValue,0);assert.equal(b.appeals['a|c1'].dec,null);
});
test('calendar timestamps have no invented audio alignment',()=>{
 const b=toBootstrap(state(),'DEV');assert.equal(b.dialogs[0].seekable,false);assert.equal(b.dialogs[0].raw[0][3],conversation.transcript[0].timestamp);
});

test('ordinal transcript labels preserve source text without invented timing or NaN duration',()=>{
 const s=state();s.conversations[0]={...conversation,channel:'agent chat',transcript:conversation.transcript.map((m,i)=>({...m,timestamp:`Turn ${i+1} (source has no timestamps)`}))};
 const d=toBootstrap(s,'DEV').dialogs[0];
 assert.equal(d.duration,null);assert.equal(d.seekable,false);
 assert.deepEqual(d.raw.map(m=>m[0]),[null,null]);
 assert.equal(d.raw[1][3],'Turn 2 (source has no timestamps)');
});
test('polling keeps an explicit rubric and stale transcript cannot enqueue',async()=>{
 const s=state(),old=s.rubrics[0];s.rubrics.push({...old,id:'new',version:2});let writes=0;
 const api=createArchiveApi({fetcher:async(path)=>{if(path!=='/api/state')writes++;return new Response(JSON.stringify(s));}});
 const b=await api('GET',`/api/bootstrap?group=DEV&rubricId=${old.id}`);assert.equal(b.checklist.id,old.id);
 await assert.rejects(()=>api('POST','/api/evaluate',{dialogId:'a',hashes:{a:'stale'}}),/Транскрипт изменился/);assert.equal(writes,0);
});
test('batch schedules every dialog in one durable server request',async()=>{
 const s=state();s.conversations.push({...conversation,conversation_id:'b'});let posted;
 const api=createArchiveApi({pause:async()=>{},fetcher:async(path,opts={})=>{
  if(path==='/api/jobs'){posted=JSON.parse(opts.body);s.jobs=[{id:'batch',status:'completed',results:[{conversationId:'a',error:'Test failure'},{conversationId:'b',error:'Test failure'}]}];return new Response(JSON.stringify({id:'batch'}));}
  return new Response(JSON.stringify(s));
 }});
 await api('GET','/api/bootstrap?group=DEV');const result=await api('POST','/api/batch',{dialogIds:['a','b']});assert.deepEqual(posted.conversationIds,['a','b']);assert.equal(result.errors.length,2);
});
test('gross AI filter preserves original finding after review and excludes unevaluated dialogs',()=>{
 const s=state();s.conversations.push({...conversation,conversation_id:'not-evaluated'});
 s.evaluations=[{id:'e',conversationId:'a',conversationHash:'current',rubricId:s.rubrics[0].id,answers:[{criterionId:'c8',answer:'yes',explanation:'Нарушение.',evidenceIds:['m1']}],reviewedAnswers:[{criterionId:'c8',answer:'no'}]}];
 const b=toBootstrap(s,'DEV');assert.equal(b.dialogs[0].grossAI,true);assert.equal(b.dialogs[0].grossFinal,false);
 assert.deepEqual(filterDialogs(b.dialogs,{gross:true}).map(d=>d.id),['a']);
 assert.deepEqual(filterDialogs(b.dialogs,{gross:true,language:'RU'}),[]);
 assert.equal(filterDialogs(b.dialogs,{query:'сәлем'}).length,2);
});

test('embedded component calls a configurable server address and imports uploaded JSON into its own group',async()=>{
 const seen=[];let current=state();
 const fetcher=async(url,options={})=>{seen.push(url);const body=options.body?JSON.parse(options.body):undefined;
  if(url.endsWith('/api/import')){current={...current,conversations:[...current.conversations,{...conversation,conversation_id:'call-1',groupId:body.groupId,audio_url:'https://cdn.example/call-1.mp3'}]};return {ok:true,json:async()=>({imported:1})};}
  return {ok:true,json:async()=>current};};
 const api=createArchiveApi({fetcher,base:'https://cqa.example.com/'});
 const result=await api('POST','/api/import-json',{payload:{isSuccess:true,data:{dataset_group_id:'CALLS',records:[]}}});
 assert.equal(result.imported,1);assert.equal(result.group,'CALLS');assert.deepEqual(result.dialogs.map(d=>[d.id,d.audio]),[['call-1','https://cdn.example/call-1.mp3']]);
 assert.ok(seen.every(url=>url.startsWith('https://cqa.example.com/api/')),seen.join(' '));
});

test('checklists are listed by name with the shipped default as the protected standard',()=>{
 const std=defaultRubric(),custom={...std,id:'x1',version:2,name:'Продажи',criteria:std.criteria.slice(0,2),createdAt:'2026-11-08T10:00:00Z'};
 const next={...custom,id:'x2',version:3,createdAt:'2026-11-08T11:00:00Z'};
 const lists=listChecklists([std,custom,next]);
 assert.deepEqual(lists.map(l=>[l.name,l.standard,l.versions,l.id]),[[std.name,true,1,std.id],['Продажи',false,2,'x2']]);
 assert.deepEqual(toBootstrap({...state(),rubrics:[std,custom,next]},'DEV','x1').checklists,lists);
});
