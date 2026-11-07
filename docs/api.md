# CQA API contract

All errors: JSON {error:string}. All fields camelCase except original conversation fields. IDs are strings. Server returns full state from GET /api/state: {conversations,rubrics,evaluations,appeals,jobs,settings}. settings={model,ollamaUrl}; rubrics array newest last.

Conversation: {conversation_id,channel,language,transcript:[{id,timestamp,speaker,text}],audio_url,groupId,hash}. IDs on transcript are stable m1,m2,... assigned on import. channel 'agent chat'|'voice call'; language RU|KZ|EN. All text treated untrusted.

Rubric: {id,version,name,createdAt,hash,criteria:[{id,title,section,description,type:'binary'|'scale'|'flag',weight,scale:number[],allowNA,naRule}]}. Binary/flag answer 'yes'|'no'; scale numeric; NA 'na'. New versions get new id; IDs of criteria user editable only for new criteria.

Evaluation: {id,conversationId,conversationHash,conversationSnapshot,rubricId,rubricHash,model,promptVersion,createdAt,durationMs,answers:[{criterionId,answer,explanation,evidenceIds:string[],checkedRange:null|{from,to}}],originalScore,finalScore,reviewedAnswers,usage}. conversationSnapshot is the immutable original Conversation, use it for evidence/transcript when viewing historical runs after reimport. Score: {total:number|null,grossViolation:boolean,applicableWeight,criteria:[{criterionId,answer,weight,effectiveWeight,contribution,normalized}],sections:[{name,earned,possible}]}. originalScore immutable. reviewedAnswers reflect decisions. answers remain original.

Appeal: {id,evaluationId,criterionId,comment,status:'open'|'resolved',createdAt,decision:null|{answer,reason,createdAt}}.

Job: {id,status:'queued'|'running'|'completed',conversationIds,rubricId,createdAt,results:[{conversationId,evaluationId?,error?}],currentConversationId:null|string}. Jobs serial; each conversation saved before next. Failed items explicit.

- GET /api/state -> full state
- GET /api/health -> {ok:true,model,ollama:{online:boolean,models:string[],error?:string},datasetConfigured:boolean}
- POST /api/settings {model} -> settings (choose installed local model)
- POST /api/import {groupId:'DEV'} -> {imported:number}; organizer URL comes from server .env, never returned
- POST /api/import {payload:<organizer JSON or records array>,groupId:'UPLOAD'} -> {imported:number}
- POST /api/rubrics {name,criteria} -> newly saved rubric version
- POST /api/evaluate {conversationId,rubricId} -> Evaluation; fresh inference, no cache
- POST /api/jobs {conversationIds,rubricId} -> Job, 202. Poll state while running.
- POST /api/appeals {evaluationId,criterionId,comment} -> Appeal
- POST /api/appeals/:id/resolve {answer,reason} -> {appeal,evaluation}
- GET /api/export -> JSON state (no settings/secrets, includes rubric + transcripts + original/final scores)

Frontend: use fetch to same-origin. Never show a placeholder score. Model offline is explicit. Manual JSON upload and organizer import are both accessible. Choosing rubric shows evaluation only matching its id AND conversation hash. Historical runs accessible via evaluation selector. For audio, use original URL audio player; only seek MM:SS times where appropriate, do not assume ISO epochs are audio offsets. UI may offer a manual time offset for recordings but not required. Sections show earned/possible values, not fabricated percentages. All user text escaped via textContent or explicit HTML escaping.
