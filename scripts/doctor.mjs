// Read-only preflight: metadata requests only; never starts jobs or downloads models.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, join, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';

export function versionAtLeast(actual, minimum) {
  const match=/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(actual));
  if (!match) return false;
  const parts=match.slice(1).map(Number), wanted=minimum.split('.').map(Number);
  for (let i=0;i<3;i++) if (parts[i]!==wanted[i]) return parts[i]>wanted[i];
  return true;
}

function probePython(root, env) {
  const code='import sys,json; import av,numpy,faster_whisper,sherpa_onnx; print(json.dumps({"version":".".join(map(str,sys.version_info[:3])),"packages":True}))';
  const result=spawnSync(env.CQA_PYTHON||'python',['-B','-c',code],{
    cwd:root,windowsHide:true,encoding:'utf8',timeout:20000,maxBuffer:65536,
    env:{...env,PYTHONDONTWRITEBYTECODE:'1',HF_HUB_OFFLINE:'1',
      PYTHONPATH:join(root,'.local/audio-python')+(env.PYTHONPATH?delimiter+env.PYTHONPATH:'')}
  });
  try {return result.status===0?JSON.parse(result.stdout.trim()):null;} catch {return null;}
}

export async function diagnose({root=process.cwd(),env=process.env,nodeVersion=process.versions.node,fetcher=fetch,pythonProbe=probePython}={}) {
  const checks=[];
  const add=(id,status,message)=>checks.push({id,status,message});
  add('node',versionAtLeast(nodeVersion,'20.20.0')?'ok':'fail',
    versionAtLeast(nodeVersion,'20.20.0')?'Node.js 20.20+ доступен.':'Установите Node.js 20.20+ и повторите проверку.');
  let config={...env};
  try {
    if (existsSync(join(root,'.env'))) {
      config={...parseEnv(readFileSync(join(root,'.env'),'utf8')),...env};
      add('env','ok','.env прочитан; значения скрыты. Переменные окружения имеют приоритет.');
    } else add('env','info','.env отсутствует: используются локальные значения по умолчанию. Для DEV скопируйте .env.example в .env.');
  } catch {add('env','fail','Не удалось прочитать .env. Проверьте права и формат файла; не публикуйте его содержимое.');}
  add('dataset',config.DATASET_URL?'ok':'info',config.DATASET_URL?
    'Адрес DEV настроен; доступность не проверялась.':'DATASET_URL не задан. Можно импортировать JSON вручную; для DEV заполните .env адресом GET из Student Guide.');
  const port=Number(config.PORT||3000);
  add('port',Number.isInteger(port)&&port>0&&port<=65535?'info':'fail',
    Number.isInteger(port)&&port>0&&port<=65535?`Приложение: http://127.0.0.1:${port}. Занятость порта не проверяется.`:'PORT должен быть целым числом от 1 до 65535.');
  let model=config.OLLAMA_MODEL||'qwen3.5:9b';
  const statePath=join(root,'.local/state.json');
  if (existsSync(statePath)) {
    try {
      const state=JSON.parse(readFileSync(statePath,'utf8'));
      if (!state.settings||typeof state.settings.model!=='string'||!Array.isArray(state.conversations)) throw Error();
      model=state.settings.model;
      add('state','ok','Сохранённое состояние прочитано без изменений. Проверяется выбранная в нём модель; OLLAMA_MODEL задаёт только начальный выбор.');
      add('data',state.conversations.length?'ok':'info',state.conversations.length?'В состоянии есть диалоги; содержимое не выводится.':'Диалогов пока нет. Импортируйте JSON через интерфейс.');
    } catch {add('state','fail','Не удалось прочитать .local/state.json. Сохраните отдельную резервную копию и проверьте файл; не удаляйте результаты.');}
  } else add('data','info','Чистый запуск: диалогов и оценок нет. Импортируйте JSON; официальный Ground Truth не поставляется.');

  let url;
  try {
    url=new URL(config.OLLAMA_URL||'http://127.0.0.1:11434');
    if (url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password) throw Error();
  } catch {url=null;add('ollama','fail','OLLAMA_URL должен указывать на локальный HTTP-сервер без логина: http://127.0.0.1:11434.');}
  if (url) {
    const request=async(path,body)=>{
      const response=await fetcher(new URL(path,url),{
        method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(3000),
        ...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})
      });
      if (!response.ok) throw Error();
      return response.json();
    };
    try {
      const [version,tags]=await Promise.all([request('/api/version'),request('/api/tags')]);
      add('ollama',versionAtLeast(version.version,'0.40.15')?'ok':'fail',versionAtLeast(version.version,'0.40.15')?
        'Локальный Ollama 0.40.15+ отвечает.':'Обновите Ollama до 0.40.15+ и перезапустите его.');
      const installed=tags.models?.find(item=>item.name===model||item.name===`${model}:latest`);
      if (!installed?.digest) add('model','fail','Выбранная модель не установлена. Для начальной конфигурации выполните ollama pull qwen3.5:9b. Сохранённый выбор можно изменить в /classic.');
      else {
        const show=await request('/api/show',{model});
        const cloud=/cloud/i.test(model)||installed.remote_host||installed.remote_model||show.remote_host||show.remote_model;
        add('model',cloud?'fail':'ok',cloud?'Выбран облачный псевдоним. Установите и выберите локальную модель в /classic.':'Выбранная модель установлена локально; облачных метаданных нет. Генерация и качество не проверялись.');
      }
    } catch {add('ollama','fail','Ollama или метаданные модели недоступны. Запустите Ollama (ollama serve), проверьте OLLAMA_URL и повторите проверку.');}
  }

  let python;
  try {python=await pythonProbe(root,config);} catch {}
  const pythonReady=python?.packages&&versionAtLeast(python.version,'3.10.0');
  add('audio-python',pythonReady?'ok':'warn',pythonReady?
    'Необязательное аудио: Python 3.10+ и библиотеки импортируются.':'Необязательное аудио: проверьте Python 3.10+, CQA_PYTHON и выполните scripts/setup-audio.ps1 с этим интерпретатором. Текстовый режим доступен.');
  const modelRoot=join(root,'.local/audio-models');
  const file=path=>{try {return statSync(path).isFile()&&statSync(path).size>0;} catch {return false;}};
  const asr=config.CQA_ASR_MODEL?resolve(root,config.CQA_ASR_MODEL):
    join(modelRoot,file(join(modelRoot,'whisper-small/model.bin'))?'whisper-small':'whisper-base');
  const audioFiles=['model.bin','config.json','tokenizer.json'].every(name=>file(join(asr,name)))&&
    ['segmentation.onnx','embedding.onnx'].every(name=>file(join(modelRoot,name)));
  add('audio-models',audioFiles?'ok':'warn',audioFiles?
    'Файлы моделей аудио найдены; их загрузка в память и качество ASR не проверялись.':'Необязательное аудио: локальные файлы моделей отсутствуют или неполны. Выполните scripts/setup-audio.ps1; проверка ничего не скачивает. Для CQA_ASR_MODEL используйте путь к локальной папке.');
  return {ready:!checks.some(check=>check.status==='fail'),checks};
}

if (process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result=await diagnose();
    console.log('CQA: проверка готовности (без установки, загрузок и оценивания)');
    for (const check of result.checks) console.log(`[${check.status.toUpperCase()}] ${check.message}`);
    console.log(result.ready?'Готовность текстового оценивания: ДА. Запуск: npm start.':'Готовность текстового оценивания: НЕТ. Исправьте FAIL; интерфейс можно открыть через npm start.');
    console.log('WARN относится к необязательному аудио. Чужой сервер не останавливается; файлы не изменяются.');
    process.exitCode=result.ready?0:1;
  } catch {console.error('Проверка не завершена. Запустите её из папки проекта на Node.js 20.20+.');process.exitCode=1;}
}
