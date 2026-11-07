import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve,delimiter } from 'node:path';

export function transcribeLocal(job,onProgress) {
  return new Promise((accept,reject)=>{
    const python=process.env.CQA_PYTHON||'python';
    const child=spawn(python,[resolve('scripts/transcribe_audio.py'),'--input',job.filePath,'--output',job.resultPath,'--language',job.language,'--speakers',String(job.speakers),'--channel-mode',job.channelMode||'mixed'],{
      shell:false,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONPATH:resolve('.local/audio-python')+(process.env.PYTHONPATH?delimiter+process.env.PYTHONPATH:'')},stdio:['ignore','pipe','pipe']
    });
    let buffer='',error='',stderr='',closed=false;
    const timeout=setTimeout(()=>{error='Обработка не завершилась за 30 минут.';child.kill();},30*60*1000);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      buffer+=chunk;if(buffer.length>100000){error='Некорректный ответ распознавания.';child.kill();return;}
      let newline;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
        let message;try{message=JSON.parse(line);}catch{continue;}
        if(message.error)error=String(message.error).slice(0,1000);
        else if(message.stage)try{onProgress(message);}catch(e){error=e.message;child.kill();}
      }
    });
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
    child.on('error',()=>{closed=true;clearTimeout(timeout);reject(Error('Python не запущен. Выполните scripts/setup-audio.ps1 и задайте CQA_PYTHON при необходимости.'));});
    child.on('close',async code=>{
      if(closed)return;clearTimeout(timeout);
      if(code!==0||error){reject(Error(error||'Не удалось запустить распознавание. Проверьте установку scripts/setup-audio.ps1.'));return;}
      try{accept(JSON.parse(await readFile(job.resultPath,'utf8')));}catch{reject(Error('Результат распознавания не сохранён.'));}
    });
  });
}
