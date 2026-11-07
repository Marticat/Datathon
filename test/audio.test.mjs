import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { mediaRange,validateAudioDraft,confirmedTurns } from '../server/audio.mjs';
const result={language:'RU',duration:12,speakers:['speaker_0','speaker_1'],segments:[{id:'seg-1',start:2.25,end:3.5,speaker:'speaker_0',text:'Здравствуйте!',uncertain:false},{id:'seg-2',start:4.1,end:5,speaker:'speaker_1',text:'Добрый день.',uncertain:false}],provenance:{asrModel:'test-only'}};
test('audio ranges support seeking, suffixes and explicit unsatisfiable ranges',()=>{
 assert.deepEqual(mediaRange('bytes=2-5',10),{start:2,end:5});assert.deepEqual(mediaRange('bytes=-3',10),{start:7,end:9});assert.deepEqual(mediaRange('bytes=8-',10),{start:8,end:9});assert.throws(()=>mediaRange('bytes=20-30',10));assert.throws(()=>mediaRange('bytes=0-1,4-5',10));
});
test('audio review requires explicit roles and immutable source segment identities',()=>{
 const draft={language:'RU',roles:{speaker_0:'operator',speaker_1:'client'},segments:result.segments.map(s=>({id:s.id,speaker:s.speaker,text:s.text,include:true}))};
 assert.equal(validateAudioDraft(result,draft,true).segments.length,2);
 assert.throws(()=>validateAudioDraft(result,{...draft,roles:{}},true),/роль/);
 assert.throws(()=>validateAudioDraft(result,{...draft,segments:[{...draft.segments[0],id:'invented'}]},true));
 assert.equal(validateAudioDraft(result,{...draft,roles:{}},false).segments.length,2);
});
test('same speaker chunks form one reply; manual roles repair a merged acoustic cluster',()=>{
 const output={...result,segments:[{...result.segments[0],end:2.8,text:'Здравствуйте.'},{...result.segments[0],id:'next',start:4,end:5,text:'Меня зовут Анна.'}]};
 const draft={language:'RU',roles:{speaker_0:'operator'},segments:output.segments.map(s=>({id:s.id,speaker:s.speaker,text:s.text,include:true}))};
 const messages=confirmedTurns(output,validateAudioDraft(output,draft,true));assert.equal(messages.length,1);assert.equal(messages[0].text,'Здравствуйте. Меня зовут Анна.');assert.equal(messages[0].startSec,2.25);assert.equal(messages[0].endSec,5);
 draft.roles={};draft.segments[0].role='operator';draft.segments[1].role='client';const split=confirmedTurns(output,validateAudioDraft(output,draft,true));assert.deepEqual(split.map(m=>m.speaker),['operator','client']);
});
test('split source segment can become two roles with bounded source times and full provenance',()=>{
 const output={...result,segments:[{id:'seg-1',start:2,end:6,speaker:'speaker_0',text:'Оператор. Клиент.',uncertain:true}]};
 const draft={language:'RU',roles:{},segments:[{id:'part-a',parentId:'seg-1',start:2,end:4,speaker:'speaker_0',text:'Оператор.',role:'operator',include:true},{id:'part-b',parentId:'seg-1',start:4,end:6,speaker:'speaker_0',text:'Клиент.',role:'client',include:true}]};
 const clean=validateAudioDraft(output,draft,true),messages=confirmedTurns(output,clean);assert.deepEqual(messages.map(m=>m.speaker),['operator','client']);assert.deepEqual(messages.map(m=>m.startSec),[2,4]);
 assert.throws(()=>validateAudioDraft(output,{...draft,segments:[{...draft.segments[0],start:1},draft.segments[1]]},true));
 assert.throws(()=>validateAudioDraft(output,{...draft,segments:[draft.segments[0],{...draft.segments[1],start:4.1}]},true));
 assert.throws(()=>validateAudioDraft(output,{...draft,segments:[draft.segments[0]]},true));
});
test('upload -> transcription -> review -> source seek -> publish preserves original ASR and history',async t=>{
 mkdirSync(resolve('.local/tests'),{recursive:true});const dir=mkdtempSync(resolve('.local/tests/audio-'));
 const app=createApp({dataFile:join(dir,'state.json'),audioWorker:async(job,progress)=>{progress({stage:'transcribing',progress:50});return structuredClone(result);},evaluator:async(c,r)=>({answers:r.criteria.map(x=>({criterionId:x.id,answer:x.type==='scale'?x.scale.at(-1):x.type==='flag'?'no':'yes',explanation:'Тест.',evidenceIds:['m1']}))})});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));rmSync(dir,{recursive:true,force:true});});
 const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 const uploaded=await fetch(base+'/api/audio/upload?filename=voice.ogg&language=RU&speakers=auto',{method:'POST',headers:{'content-type':'audio/ogg'},body:Buffer.from('0123456789')});assert.equal(uploaded.status,202);const job=await uploaded.json();
 let detail;for(let i=0;i<30;i++){detail=await (await fetch(base+'/api/audio/jobs/'+job.id)).json();if(detail.status==='needs_review')break;await new Promise(r=>setTimeout(r,10));}assert.equal(detail.status,'needs_review');
 assert.equal((await (await fetch(base+'/api/state')).json()).conversations.length,0);
 const range=await fetch(base+'/api/audio/files/'+job.id,{headers:{range:'bytes=2-5'}});assert.equal(range.status,206);assert.equal(await range.text(),'2345');assert.equal(range.headers.get('content-range'),'bytes 2-5/10');
 const draft={language:'RU',roles:{speaker_0:'operator',speaker_1:'client'},segments:result.segments.map(s=>({id:s.id,speaker:s.speaker,text:s.text,include:true}))};
 assert.equal((await post('/api/audio/jobs/'+job.id+'/draft',draft)).status,200);
 assert.equal((await post('/api/audio/jobs/'+job.id+'/publish',{...draft,roles:{}})).status,400);
 const publication=await post('/api/audio/jobs/'+job.id+'/publish',draft);assert.equal(publication.status,200);
 const s=app.store.read(),conversation=s.conversations[0];assert.equal(conversation.transcript[0].speaker,'operator');assert.equal(conversation.transcript[0].startSec,2.25);assert.match(conversation.audio_url,/\/api\/audio\/files\//);
 const evaluation=await post('/api/evaluate',{conversationId:conversation.conversation_id,rubricId:s.rubrics[0].id});assert.equal(evaluation.status,200);
 draft.segments[0].text='Исправленная расшифровка.';await post('/api/audio/jobs/'+job.id+'/publish',draft);
 assert.notEqual(app.store.read().conversations[0].hash,conversation.hash);assert.equal(app.store.read().evaluations[0].conversationSnapshot.transcript[0].text,'Здравствуйте!');
 detail=await (await fetch(base+'/api/audio/jobs/'+job.id)).json();assert.equal(detail.result.segments[0].text,'Здравствуйте!');assert.equal(detail.draft.segments[0].text,'Исправленная расшифровка.');
 assert.equal((await fetch(base+'/api/audio/upload?filename=../evil.exe',{method:'POST',body:'no'})).status,400);
 const crossed=await fetch(base+'/api/audio/upload?filename=voice.ogg',{method:'POST',headers:{origin:'https://evil.example','content-type':'audio/ogg'},body:'bad'});assert.equal(crossed.status,403);
});
