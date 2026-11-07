import test from 'node:test';
import assert from 'node:assert/strict';
import { speakerLabel, makeDraft } from '../public/audio.js';

test('separate channel names identify the recording channel without inferring business roles',()=>{
 assert.equal(speakerLabel('speaker_channel_0',0),'Левый канал');
 assert.equal(speakerLabel('speaker_channel_1',1),'Правый канал');
 assert.equal(speakerLabel('speaker_0',0),'Голос 1');
 assert.equal(speakerLabel('unknown',2),'Неопределённый голос');
 const draft=makeDraft({result:{language:'EN',speakers:['speaker_channel_0','speaker_channel_1'],segments:[]}});
 assert.deepEqual(draft.roles,{speaker_channel_0:'',speaker_channel_1:''});
});
