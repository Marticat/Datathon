import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from audio_alignment import align_words,timeline_position
class AlignmentTests(unittest.TestCase):
 def test_source_silence_and_speaker_change(self):
  words=[{'start':4.0,'end':4.5,'text':'Здравствуйте.'},{'start':7,'end':7.4,'text':' Добрый день.'}]
  turns=[{'start':3.8,'end':4.8,'speaker':'speaker_0'},{'start':6.9,'end':8,'speaker':'speaker_1'}]
  result=align_words(words,turns)
  self.assertEqual(result[0]['start'],4.0)
  self.assertEqual([x['speaker'] for x in result],['speaker_0','speaker_1'])
 def test_overlap_unknown_and_gap_are_not_guessed(self):
  turns=[{'start':0,'end':2,'speaker':'a'},{'start':0,'end':1.8,'speaker':'b'}]
  result=align_words([{'start':.5,'end':1,'text':'Вместе'},{'start':5,'end':6,'text':'Без голоса'}],turns)
  self.assertTrue(all(x['uncertain'] for x in result));self.assertTrue(all(x['speaker']=='unknown' for x in result))
 def test_same_speaker_can_have_separate_turns(self):
  result=align_words([{'start':0,'end':.4,'text':'Один'},{'start':.4,'end':.8,'text':' голос.'},{'start':3,'end':4,'text':'Снова.'}],[{'start':0,'end':5,'speaker':'a'}])
  self.assertEqual(len(result),2);self.assertEqual(result[0]['text'],'Один голос.')
 def test_frame_pts_gaps_are_preserved_in_reference_timeline(self):
  target,drop,origin=timeline_position(0,1/16000,16000,0,None)
  self.assertEqual((target,drop),(0,0))
  target,drop,origin=timeline_position(32000,1/16000,16000,16000,origin)
  self.assertEqual((target,drop),(32000,0))
  self.assertEqual(target-16000,16000)
 def test_repeated_frame_time_is_trimmed_not_shifted(self):
  target,drop,_=timeline_position(8000,1/16000,16000,16000,0)
  self.assertEqual((target,drop),(8000,8000))
if __name__=='__main__':unittest.main()
