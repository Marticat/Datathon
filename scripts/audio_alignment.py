"""Align ASR words to acoustic speakers without inventing business roles."""
def align_words(words, turns, max_utterance=12.0):
    output=[]
    for word in words:
        start,end=float(word['start']),float(word['end'])
        text=str(word['text'])
        if not text.strip() or end<start:
            continue
        overlaps={}
        for turn in turns:
            overlap=max(0.0,min(end,turn['end'])-max(start,turn['start']))
            if overlap:
                overlaps[turn['speaker']]=overlaps.get(turn['speaker'],0)+overlap
        ranked=sorted(overlaps.items(),key=lambda pair:pair[1],reverse=True)
        # No nearby speech/overlapping speakers: keep explicit uncertainty.
        speaker=ranked[0][0] if ranked else 'unknown'
        overlap=len(ranked)>1 and ranked[1][1]>ranked[0][1]*0.35
        uncertain=not ranked or overlap or float(word.get('probability',1))<.45
        if not ranked or overlap:
            speaker='unknown'
        previous=output[-1] if output else None
        if previous and previous['speaker']==speaker and previous['uncertain']==uncertain and start-previous['end']<0.75 and end-previous['start']<=max_utterance:
            previous['text']+=text
            previous['end']=end
            previous['words'].append({'start':start,'end':end,'text':text})
        else:
            output.append({'id':f'seg-{len(output)+1}','start':start,'end':end,'speaker':speaker,'text':text,'uncertain':bool(uncertain),'overlap':bool(overlap),'words':[{'start':start,'end':end,'text':text}]})
    for segment in output:
        segment['text']=segment['text'].strip()
    return output

def timeline_position(pts,time_base,length,position,origin,rate=16000):
    """Keep frame gaps; normalize the reference WAV's first timestamp to zero."""
    if pts is None or time_base is None:
        return position,0,origin
    seconds=float(pts*time_base)
    if origin is None:origin=seconds
    target=max(0,round((seconds-origin)*rate))
    return target,max(0,min(length,position-target)),origin
