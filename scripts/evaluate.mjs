// Run an actual local batch through the app; no model output fixtures.
const base=process.env.CQA_URL||'http://127.0.0.1:3000';
const [language,countArg='3']=process.argv.slice(2);
async function request(path,body){const response=await fetch(base+path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const data=await response.json();if(!response.ok)throw Error(data.error);return data;}
try {
 const state=await request('/api/state');const ids=state.conversations.filter(c=>!language||c.language===language.toUpperCase()).slice(0,Number(countArg)).map(c=>c.conversation_id);
 if(!ids.length)throw Error('No matching conversations. Import DEV first.');
 const job=await request('/api/jobs',{conversationIds:ids,rubricId:state.rubrics.at(-1).id});console.log(`Job ${job.id}: ${ids.join(', ')}`);
 let seen=0;
 while(true){const current=await request('/api/state');const progress=current.jobs.find(j=>j.id===job.id);
  for(const result of progress.results.slice(seen)){const ev=current.evaluations.find(e=>e.id===result.evaluationId);console.log(JSON.stringify(result.error?result:{conversationId:result.conversationId,total:ev.originalScore.total,grossViolation:ev.originalScore.grossViolation,model:ev.model,durationMs:ev.durationMs}));}
  seen=progress.results.length;if(progress.status==='completed'){if(progress.results.some(r=>r.error))process.exitCode=1;break;}await new Promise(r=>setTimeout(r,2000));
 }
}catch(error){console.error(error.message);process.exitCode=1;}
