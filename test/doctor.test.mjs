import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { diagnose, versionAtLeast } from '../scripts/doctor.mjs';

function fixture(t) {
  mkdirSync(resolve('.local/tests'),{recursive:true});
  const root=mkdtempSync(resolve('.local/tests/cqa-doctor-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return root;
}
const pythonProbe=()=>({version:'3.12.0',packages:true});
function ollama({version='0.40.15',models=[{name:'qwen3.5:9b',digest:'abc'}],show={}}={}) {
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push([url.pathname,options?.method]);
    assert.ok(['/api/tags','/api/version','/api/show'].includes(url.pathname));
    return {ok:true,json:async()=>url.pathname==='/api/tags'?{models}:url.pathname==='/api/version'?{version}:show};
  };
  return {fetcher,calls};
}
test('version checks reject old and malformed runtimes',()=>{
  assert.equal(versionAtLeast('20.19.9','20.20.0'),false);
  assert.equal(versionAtLeast('20.20.0','20.20.0'),true);
  assert.equal(versionAtLeast('1.0.0','0.40.15'),true);
  assert.equal(versionAtLeast('0.40','0.40.15'),false);
});
test('fresh checkout is diagnosed without writing state, installing or inference',async t=>{
  const root=fixture(t), remote=ollama();
  const result=await diagnose({root,env:{},nodeVersion:'20.20.0',pythonProbe,...remote});
  assert.equal(result.ready,true);
  assert.ok(result.checks.some(c=>c.id==='data'&&c.status==='info'));
  assert.ok(result.checks.some(c=>c.id==='audio-models'&&c.status==='warn'));
  assert.deepEqual(readdirSync(root),[]);
  assert.deepEqual(remote.calls.map(c=>c[0]).sort(),['/api/show','/api/tags','/api/version']);
});
test('missing .env does not block manual JSON import; missing model blocks scoring readiness',async t=>{
  const root=fixture(t);
  const result=await diagnose({root,env:{},nodeVersion:'20.20.0',pythonProbe,...ollama({models:[]})});
  assert.equal(result.ready,false);
  assert.equal(result.checks.find(c=>c.id==='model').status,'fail');
  assert.match(result.checks.find(c=>c.id==='dataset').message,/JSON/);
});
test('uses saved model, preserves state bytes, and never prints private configuration',async t=>{
  const root=fixture(t);mkdirSync(join(root,'.local'));
  writeFileSync(join(root,'.env'),'DATASET_URL=https://private.invalid/secret-token\nOLLAMA_MODEL=ignored\n');
  const state=JSON.stringify({settings:{model:'saved:latest'},conversations:[{secret:'private-transcript'}]});
  writeFileSync(join(root,'.local/state.json'),state);
  const result=await diagnose({root,env:{},nodeVersion:'22.0.0',pythonProbe,...ollama({models:[{name:'saved:latest',digest:'abc'}]})});
  assert.equal(result.ready,true);
  assert.equal(readFileSync(join(root,'.local/state.json'),'utf8'),state);
  assert.doesNotMatch(JSON.stringify(result),/secret-token|private-transcript|private.invalid/);
});
test('remote URL and redirects are rejected before sending metadata requests',async t=>{
  const root=fixture(t);let calls=0;
  const result=await diagnose({root,env:{OLLAMA_URL:'https://private.invalid/secret'},nodeVersion:'22.0.0',pythonProbe,fetcher:()=>{calls++;throw Error();}});
  assert.equal(result.ready,false);assert.equal(calls,0);
  assert.doesNotMatch(JSON.stringify(result),/private.invalid|secret/);
  const local=await diagnose({root,env:{},nodeVersion:'22.0.0',pythonProbe,fetcher:async(url,options)=>{
    assert.equal(options.redirect,'error');throw Error('private diagnostic response');
  }});
  assert.equal(local.ready,false);assert.doesNotMatch(JSON.stringify(local),/private diagnostic/);
});
test('old runtime, cloud aliases and invalid state are explicit blockers',async t=>{
  const root=fixture(t);
  for (const remote of [ollama({version:'0.40.14'}),ollama({show:{remote_model:'cloud'}})]) {
    assert.equal((await diagnose({root,env:{},nodeVersion:'22.0.0',pythonProbe,...remote})).ready,false);
  }
  mkdirSync(join(root,'.local'));writeFileSync(join(root,'.local/state.json'),'{');
  const result=await diagnose({root,env:{},nodeVersion:'22.0.0',pythonProbe,...ollama()});
  assert.equal(result.checks.find(c=>c.id==='state').status,'fail');assert.equal(result.ready,false);
});
test('clean source copy starts with empty isolated state and serves every judge entry page',async t=>{
  const root=fixture(t);
  // Deliberately omit .env, .local, node_modules and all private datasets.
  for (const name of ['server','public']) cpSync(new URL(`../${name}/`,import.meta.url),join(root,name),{recursive:true});
  const {createApp}=await import(pathToFileURL(join(root,'server/app.mjs')));
  const app=createApp({dataFile:join(root,'.local/state.json'),publicDir:join(root,'public'),datasetUrl:''});
  await new Promise((accept,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',accept);});
  t.after(()=>new Promise(accept=>app.server.close(accept)));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  for (const path of ['/','/classic','/audio']) {
    const response=await fetch(base+path);
    assert.equal(response.status,200,path);assert.match(await response.text(),/<html/i);
  }
  const state=await (await fetch(base+'/api/state')).json();
  assert.deepEqual(state.conversations,[]);assert.deepEqual(state.evaluations,[]);assert.deepEqual(state.jobs,[]);
  assert.equal(state.rubrics[0].criteria.length,8);
});
