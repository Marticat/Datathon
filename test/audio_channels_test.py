import sys, tempfile, unittest, wave
from pathlib import Path
from fractions import Fraction
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import transcribe_audio
import audio_alignment
from types import SimpleNamespace

class ChannelTests(unittest.TestCase):
 def test_stereo_decode_keeps_channel_identity_and_leading_silence(self):
  import numpy as np
  with tempfile.TemporaryDirectory() as directory:
   path=Path(directory)/'stereo.wav'
   data=np.zeros((48000,2),dtype='<i2');data[12000:24000,0]=12000;data[24000:36000,1]=-6000
   with wave.open(str(path),'wb') as out:
    out.setnchannels(2);out.setsampwidth(2);out.setframerate(48000);out.writeframes(data.tobytes())
   channels=transcribe_audio.decode_audio_channels(path)
   self.assertEqual(channels.shape,(2,16000))
   self.assertAlmostEqual(float(channels[0,6000]),12000/32768,places=4)
   self.assertAlmostEqual(float(channels[1,10000]),-6000/32768,places=4)
   self.assertEqual(float(channels[1,6000]),0)
   self.assertEqual(float(channels[0,1000]),0)

 def test_separate_decode_rejects_mono(self):
  with tempfile.TemporaryDirectory() as directory:
   path=Path(directory)/'mono.wav'
   with wave.open(str(path),'wb') as out:
    out.setnchannels(1);out.setsampwidth(2);out.setframerate(16000);out.writeframes(b'\0\0'*1600)
   with self.assertRaisesRegex(ValueError,'2|два|стерео'):
    transcribe_audio.decode_audio_channels(path)

 def test_pts_gap_is_silence_in_both_channels_without_changing_origin(self):
  import av, numpy as np
  frames=[]
  for pts in (80000,112000):
   frame=av.AudioFrame.from_ndarray(np.array([[.25]*16000,[-.5]*16000],dtype='float32'),format='fltp',layout='stereo')
   frame.sample_rate=16000;frame.pts=pts;frame.time_base=Fraction(1,16000);frames.append(frame)
  class Source:
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def decode(self,**kwargs):return iter(frames)
  with patch('av.open',return_value=Source()):
   channels=transcribe_audio.decode_audio_channels('timestamped-source')
  self.assertEqual(channels.shape,(2,48000))
  self.assertTrue(np.all(channels[:,16000:32000]==0))
  self.assertAlmostEqual(float(channels[0,40000]),.25)
  self.assertAlmostEqual(float(channels[1,40000]),-.5)

 def test_channel_words_interleave_without_erasing_overlap_or_low_confidence(self):
  words=[[{'start':1,'end':2,'text':' Greeting','probability':.9}, {'start':4,'end':5,'text':' Reply','probability':.2}],
         [{'start':1.5,'end':2.5,'text':' Client','probability':.8}]]
  result=audio_alignment.align_channel_words(words)
  self.assertEqual([s['speaker'] for s in result],['speaker_channel_0','speaker_channel_1','speaker_channel_0'])
  self.assertEqual([s['start'] for s in result],[1,1.5,4])
  self.assertEqual([s['overlap'] for s in result],[True,True,False])
  self.assertEqual([s['uncertain'] for s in result],[False,False,True])
  self.assertEqual(result[1]['words'][0]['end'],2.5)
  self.assertEqual(len(set(s['id'] for s in result)),3)

 def test_zero_duration_word_keeps_known_channel_identity(self):
  result=audio_alignment.align_channel_words([[{'start':2,'end':2,'text':' hello','probability':.9}],[]])
  self.assertEqual(result[0]['speaker'],'speaker_channel_0')
  self.assertFalse(result[0]['uncertain'])
  self.assertEqual(result[0]['words'][0]['start'],result[0]['words'][0]['end'])

 def test_separate_pipeline_needs_no_diarizer_and_uses_each_channel(self):
  import numpy as np
  # Only the expensive recognizer is replaced; decoding, channel routing,
  # alignment, playback and result serialization are the production path.
  class Recognizer:
   def __init__(self,*args,**kwargs):pass
   def transcribe(self,samples,**kwargs):
    text=' Greeting' if samples[8000]>0 else ' Client'
    word=SimpleNamespace(start=.5,end=.9,word=text,probability=.9)
    return iter([SimpleNamespace(end=.9,words=[word])]),SimpleNamespace(language='ru')
  with tempfile.TemporaryDirectory(dir=transcribe_audio.ROOT) as directory:
   root=Path(directory);source=root/'stereo.wav';target=root/'output/result.json'
   original=np.tile(np.array([12000,-6000],dtype='<i2'),(16000,1)).tobytes()
   with wave.open(str(source),'wb') as out:
    out.setnchannels(2);out.setsampwidth(2);out.setframerate(16000);out.writeframes(original)
   source_hash=transcribe_audio.file_sha256(source)
   with patch.object(transcribe_audio,'ROOT',root),patch.object(transcribe_audio,'emit'),patch.dict(sys.modules,{'faster_whisper':SimpleNamespace(WhisperModel=Recognizer),'sherpa_onnx':None}),patch.object(sys,'argv',['worker','--input',str(source),'--output',str(target),'--channel-mode','separate']):
    transcribe_audio.main()
   import json
   result=json.loads(target.read_text(encoding='utf-8'))
   self.assertEqual([s['text'] for s in result['segments']],['Greeting','Client'])
   self.assertEqual(result['speakers'],['speaker_channel_0','speaker_channel_1'])
   self.assertEqual(result['provenance']['diarization'],'source-stereo-channels')
   self.assertTrue(result['warnings'])
   self.assertEqual(source_hash,transcribe_audio.file_sha256(source))
   with wave.open(str(target.parent/'playback.wav'),'rb') as recording:
    self.assertEqual(recording.getnframes(),16000)
    self.assertEqual(recording.getnchannels(),1)
    self.assertAlmostEqual(int(np.frombuffer(recording.readframes(16000),dtype='<i2')[8000]),3000,delta=1)

if __name__=='__main__':unittest.main()
