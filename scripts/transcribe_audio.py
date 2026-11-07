"""Local CPU ASR/diarization worker. stdout is a small JSON-lines protocol."""
import argparse,json,os,sys,hashlib,wave
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'.local/audio-python'))
from audio_alignment import align_words,timeline_position

def emit(**value):
 print(json.dumps(value,ensure_ascii=False),flush=True)

def file_sha256(path):
 digest=hashlib.sha256()
 with Path(path).open('rb') as source:
  for block in iter(lambda:source.read(4*1024*1024),b''):digest.update(block)
 return digest.hexdigest()

def decode_audio(path,max_seconds=1200):
 import av,numpy as np
 chunks=[];count=0;origin=None
 def append_frame(converted):
  nonlocal count,origin
  samples=converted.to_ndarray().reshape(-1)
  target,drop,origin=timeline_position(converted.pts,converted.time_base,len(samples),count,origin)
  gap=max(0,target-count)
  if count+gap+len(samples)-drop>max_seconds*16000:raise ValueError('Максимальная длительность записи — 20 минут.')
  if gap:chunks.append(np.zeros(gap,dtype='float32'));count+=gap
  if drop:samples=samples[drop:]
  chunks.append(samples);count+=len(samples)
 with av.open(path) as source:
  resampler=av.AudioResampler(format='fltp',layout='mono',rate=16000)
  for frame in source.decode(audio=0):
   for converted in resampler.resample(frame):
    append_frame(converted)
  for converted in resampler.resample(None):
   append_frame(converted)
 if not count:raise ValueError('Аудиофайл не содержит звука.')
 if count>max_seconds*16000:raise ValueError('Максимальная длительность записи — 20 минут.')
 return np.concatenate(chunks).astype('float32')

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--input',required=True);parser.add_argument('--output',required=True);parser.add_argument('--language',default='auto');parser.add_argument('--speakers',type=int,default=-1)
 args=parser.parse_args()
 from faster_whisper import WhisperModel
 import sherpa_onnx
 models=ROOT/'.local/audio-models'
 segmentation=models/'segmentation.onnx';embedding=models/'embedding.onnx'
 if not segmentation.is_file() or not embedding.is_file():raise ValueError('Модели голосов не установлены. Выполните scripts/setup-audio.ps1.')
 emit(stage='decoding',progress=5)
 samples=decode_audio(args.input);duration=len(samples)/16000
 import numpy as np
 playback=Path(args.output).parent/'playback.wav'
 with wave.open(str(playback),'wb') as recording:
  recording.setnchannels(1);recording.setsampwidth(2);recording.setframerate(16000)
  recording.writeframes((np.clip(samples,-1,1)*32767).astype('<i2').tobytes())
 emit(stage='transcribing',progress=10)
 local_model=models/'whisper-small' if (models/'whisper-small/model.bin').is_file() else models/'whisper-base'
 model_name=os.environ.get('CQA_ASR_MODEL',str(local_model) if local_model.is_dir() else 'base')
 asr=WhisperModel(model_name,device='cpu',compute_type='int8',cpu_threads=4,local_files_only=True)
 lang={'RU':'ru','KZ':'kk','EN':'en'}.get(args.language)
 segments,info=asr.transcribe(samples,language=lang,beam_size=5,word_timestamps=True,vad_filter=True,condition_on_previous_text=False)
 words=[]
 for segment in segments:
  for word in segment.words or []:
   words.append({'start':float(word.start),'end':float(word.end),'text':word.word,'probability':float(word.probability)})
  emit(stage='transcribing',progress=10+min(50,50*segment.end/duration))
 if not words:raise ValueError('Речь не распознана. Проверьте запись или выберите язык вручную.')
 del asr
 emit(stage='diarizing',progress=65)
 config=sherpa_onnx.OfflineSpeakerDiarizationConfig(
  segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(segmentation)),num_threads=4,provider='cpu'),
  embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(embedding),num_threads=4,provider='cpu'),
  clustering=sherpa_onnx.FastClusteringConfig(num_clusters=args.speakers,threshold=.5),min_duration_on=.3,min_duration_off=.5)
 if not config.validate():raise ValueError('Не удалось открыть модели разделения голосов.')
 diarizer=sherpa_onnx.OfflineSpeakerDiarization(config)
 turns=[{'start':float(t.start),'end':float(t.end),'speaker':f'speaker_{t.speaker}'} for t in diarizer.process(samples).sort_by_start_time()]
 emit(stage='aligning',progress=95)
 utterances=align_words(words,turns)
 if not utterances:raise ValueError('Не удалось связать распознанные слова с записью.')
 if len(utterances)>3000:raise ValueError('Слишком много реплик; разделите запись на части.')
 detected=info.language
 language={'ru':'RU','kk':'KZ','en':'EN'}.get(detected)
 asr_bin=Path(model_name)/'model.bin'
 result={'language':language,'detectedLanguage':detected,'duration':duration,'speakers':sorted(set(s['speaker'] for s in utterances)), 'segments':utterances,'turns':turns,'words':words,'playback':{'format':'wav','sampleRate':16000,'timeline':'normalized-reference','sha256':file_sha256(playback)},'provenance':{'asrModel':model_name,'asrModelSHA256':file_sha256(asr_bin) if asr_bin.is_file() else None,'asrEngine':'faster-whisper','diarization':'sherpa-onnx 2.0.1','segmentationSHA256':file_sha256(segmentation),'embeddingSHA256':file_sha256(embedding)}}
 target=Path(args.output);temp=target.with_suffix('.tmp');temp.write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8');temp.replace(target)
 emit(stage='completed',progress=100)

if __name__=='__main__':
 try:main()
 except Exception as error:
  emit(error=str(error));sys.exit(1)
