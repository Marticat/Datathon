"""Download local audio models. No audio files are transmitted by this setup."""
import argparse,hashlib,json,os,sys,tarfile,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'.local/audio-python'))
MODELS=ROOT/'.local/audio-models'

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def download(name,url,expected=None):
 target=MODELS/name
 if target.is_file() and (not expected or sha(target)==expected):return target
 temporary=target.with_suffix(target.suffix+'.download')
 print('Downloading '+name,flush=True)
 request=urllib.request.Request(url,headers={'User-Agent':'CQA-local-audio-setup'})
 with urllib.request.urlopen(request,timeout=60) as response,temporary.open('wb') as output:
  while True:
   block=response.read(1024*1024)
   if not block:break
   output.write(block)
 if expected and sha(temporary)!=expected:raise RuntimeError('Model SHA-256 mismatch: '+name)
 temporary.replace(target);return target

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--asr',choices=['base','small'],default='small');args=parser.parse_args()
 MODELS.mkdir(parents=True,exist_ok=True)
 segmentation=MODELS/'segmentation.onnx'
 if not segmentation.is_file() or sha(segmentation)!='220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079':
  archive=download('segmentation.tar.bz2','https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2','24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488')
  # Extract only this known regular model member, never arbitrary archive paths.
  with tarfile.open(archive) as tar:
   member=tar.getmember('sherpa-onnx-pyannote-segmentation-3-0/model.onnx')
   if not member.isfile():raise RuntimeError('Unexpected segmentation archive')
   segmentation.write_bytes(tar.extractfile(member).read())
  if sha(segmentation)!='220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079':raise RuntimeError('Segmentation SHA-256 mismatch')
 embedding=download('embedding.onnx','https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34.onnx','5ef208a9da1453335308a6b6f4e6dfbd7e183a38b604de0a57664f45d257fe94')
 from huggingface_hub import HfApi,snapshot_download
 repo='Systran/faster-whisper-'+args.asr
 revision=HfApi().model_info(repo).sha
 print('Downloading multilingual Whisper '+args.asr+' at '+revision,flush=True)
 model=snapshot_download(repo,revision=revision,local_dir=str(MODELS/('whisper-'+args.asr)),cache_dir=str(ROOT/'.local/hf-cache'),allow_patterns=['config.json','model.bin','tokenizer.json','vocabulary.*','preprocessor_config.json'])
 record={'asr':{'repository':repo,'revision':revision,'path':str(model)},'segmentation':{'source':'https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-segmentation-models','sha256':sha(segmentation)},'embedding':{'source':'https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models','sha256':sha(embedding)}}
 (MODELS/'provenance.json').write_text(json.dumps(record,indent=2),encoding='utf-8')
 print('Audio models ready.',flush=True)

if __name__=='__main__':main()
