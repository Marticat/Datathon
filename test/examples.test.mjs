import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createApp} from '../server/app.mjs';

test('ABCD adaptation retains every original turn, action and order without invented clock times',async()=>{
 const raw=JSON.parse(await readFile('samples/abcd/source-sample.json','utf8'));
 const converted=JSON.parse(await readFile('samples/abcd/conversations.json','utf8'));
 assert.equal(converted.length,3);
 for(let i=0;i<raw.length;i++){
  assert.equal(converted[i].conversation_id,'abcd-'+raw[i].convo_id);
  assert.deepEqual(converted[i].transcript.map(m=>m.text),raw[i].original.map(m=>m[1]));
  assert.deepEqual(converted[i].transcript.map(m=>m.speaker),raw[i].original.map(m=>({agent:'operator',customer:'client',action:'system'}[m[0]])));
  assert.ok(converted[i].transcript.every(m=>m.timestamp.includes('source has no timestamps')));
 }
});
test('public examples verify hashes, import separately and reuse separate-channel audio jobs',async t=>{
 await mkdir('.local/tests',{recursive:true});const dir=await mkdtemp(resolve('.local/tests/examples-'));
 const app=createApp({dataFile:join(dir,'state.json'),audioWorker:async job=>({duration:1,language:'EN',speakers:['speaker_channel_0'],segments:[{id:'seg-1',start:0,end:1,speaker:'speaker_channel_0',text:'Test-only worker output.',uncertain:false}],provenance:{test:true}})});
 await new Promise(done=>app.server.listen(0,'127.0.0.1',done));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(done=>app.server.close(done));await rm(dir,{recursive:true,force:true});});
 const run=command=>promisify(execFile)(process.execPath,['scripts/examples.mjs',command],{env:{...process.env,CQA_URL:`http://127.0.0.1:${app.server.address().port}`},timeout:30000});
 await run('list');await run('import');await run('import');
 let state=app.store.read();assert.equal(state.conversations.length,3);assert.ok(state.conversations.every(c=>c.groupId==='EXTERNAL-ABCD'));assert.equal(state.evaluations.length,0);
 await run('audio');await run('audio');
 state=app.store.read();assert.equal(state.audioJobs.length,2);assert.ok(state.audioJobs.every(j=>j.channelMode==='separate'));assert.equal(state.conversations.length,3);
});
