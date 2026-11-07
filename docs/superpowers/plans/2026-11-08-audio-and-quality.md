# Audio and judging quality implementation plan

Goal: make the complete audio-to-evidence path usable locally, and select a better generalizable scoring approach using measured examples.

Architecture: CPU local Whisper word timestamps + neural speaker diarization; persistent upload/transcription jobs; human confirmation of roles and transcript before creating a versioned voice conversation; original source playback with byte ranges. Keep immutable ASR output separately from reviewed text. Existing rubric evaluation and appeals remain the only scoring path.

Quality priority: measure criterion predicates on a small human-audited family-held-out set, experiment with applicability/evidence extraction and independent criterion decisions, adopt only a measured improvement. Never hardcode answers for known IDs. Defer dashboards, slides, training and decorative features.

Audio API contract:
- `POST /api/audio/upload?filename=...&language=auto|RU|KZ|EN&speakers=auto|1|2|3|4`, raw audio bytes, <=80 MB, returns 202 job summary.
- `GET /api/audio/jobs` -> `{jobs:[{id,filename,status,stage,progress,createdAt,error?,conversationId?}]}`.
- `GET /api/audio/jobs/:id` -> job including `result:{language,duration,speakers:[id],segments:[{id,start,end,speaker,text,uncertain}]}` and optional `draft:{language,roles:{speaker_0:'operator',...},segments:[{id,speaker,text,include:true}]}`. Speaker identity is acoustic, never a guessed business role.
- `POST /api/audio/jobs/:id/draft`, body draft -> saves editable review. Roles may be blank in drafts; publishing requires roles for included segments.
- `POST /api/audio/jobs/:id/publish`, body draft -> `{conversationId,groupId:'AUDIO',url:'/?group=AUDIO&dialog=...'}`. Timestamps are derived from immutable original ASR segment times. Original result preserved; a later publish changes the conversation hash, not past evaluations.
- `GET|HEAD /api/audio/files/:id` -> original audio, with byte-range support. Files in ignored local data only. Decoded max duration 20 minutes.

Implementation:
- [x] Install and record local ASR/diarization dependencies and model provenance; add reproducible setup.
- [x] Implement worker and alignment with unknown/overlap handling, preserving original recording timebase; test with real audio.
- [x] Implement persisted upload/job/review/publish/media routes with injected workers for tests.
- [x] Add `/audio` page for upload, progress, original audio, role mapping, editable full transcript, save, download text, confirmation and link to scoring.
- [x] Integrate source timestamps and deep links in both existing workbenches.
- [x] Run isolated full browser journey, real audio transcription, API/domain tests and review. Publish verified changes to main per user preference.
- [x] Run bounded scoring-quality experiment and adopt only if it improves criterion correctness without hidden shortcuts.

Ruling: automatically separate voices, but ask the reviewer to confirm client/operator roles. A single-speaker message is not transformed into a fabricated two-party dialogue. Low-quality ASR and overlap remain visible and editable. No cloud audio API or upload to third parties.

Verification: 38 Node tests, 5 pure Python alignment tests, real PyAV timestamp-gap container, isolated browser/API journeys (including a merged segment split into two roles), actual 108.86s upload and canonical WAV range request. Focused c1/c2/c4 enabled after bounded experiment; c7 not promoted. Remaining semantic limitations are documented, not hidden.
