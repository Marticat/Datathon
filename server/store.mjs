import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultRubric } from './rubric.mjs';
import { hash } from './domain.mjs';
export class Store {
  constructor(file) {
    this.file=file;mkdirSync(dirname(file),{recursive:true});
    if(existsSync(file))this.state=JSON.parse(readFileSync(file,'utf8'));
    else {const rubric=defaultRubric();rubric.hash=hash(rubric.criteria);this.state={conversations:[],rubrics:[rubric],evaluations:[],appeals:[],jobs:[],settings:{model:process.env.OLLAMA_MODEL||'qwen3.5:9b',ollamaUrl:process.env.OLLAMA_URL||'http://127.0.0.1:11434'}};this.save();}
    // Resume interrupted jobs. Completed results are retained and never replayed.
    for(const job of this.state.jobs)if(job.status==='running'){job.status='queued';job.currentConversationId=null;}
    this.state.settings.ollamaUrl=process.env.OLLAMA_URL||'http://127.0.0.1:11434';this.save();
  }
  read(){return structuredClone(this.state);}
  save(){
    const temp=this.file+'.tmp';writeFileSync(temp,JSON.stringify(this.state,null,2),'utf8');
    // Windows indexers/security software can briefly hold a just-written file.
    // Preserve atomic replacement; never fall back to deleting the previous state.
    for(let attempt=0;;attempt++){
      try{renameSync(temp,this.file);return;}
      catch(error){if(process.platform!=='win32'||!['EPERM','EBUSY','EACCES'].includes(error.code)||attempt===7)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10*(attempt+1));}
    }
  }
  update(fn){const next=structuredClone(this.state);const result=fn(next);const previous=this.state;this.state=next;try{this.save();}catch(e){this.state=previous;throw e;}return structuredClone(result);}
}
