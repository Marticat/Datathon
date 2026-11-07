# Verification record

Implementation session: 2026-11-07.

## Confirmed
- All 18 automated tests pass; JavaScript syntax checks pass.
- Organizer DEV endpoint successfully returned 65 records: 35 RU, 15 KZ, 15 EN. Imported into ignored local state.
- Server/API tests cover 85.38 arithmetic, NA and scales, separate gross violation flag, structured output validation, evidence IDs, UTF-8 chunk boundaries, actual on-disk persistence, appeals, fresh rubric versions, batch partial failures and historical transcript snapshots.
- Local inference adapter tests check rejection of remote aliases, runtime version enforcement, no input truncation/context shift, and digest provenance.
- Browser checks in installed Chrome: all 65 conversations load, KZ filter/editor work, 390px layout has no horizontal overflow, no JavaScript runtime errors. No production scores were fabricated for this check.
- Isolated browser integration check with an explicitly injected test evaluator: single persistent job -> evidence navigation -> appeal -> decision (85.38 to 70) -> reload -> new rubric -> fresh evaluator call. Production state was not used for fixtures.
- Independent code review performed; original findings on metadata, truncation, UTF-8, job atomicity, provenance and UI deferred updates were fixed.
- Single-dialog evaluation also uses the persistent queue, avoiding browser timeouts while another dialog is running.
- Portable official Ollama 0.40.15 CPU/Vulkan runtime extracted. ZIP CRC verified for extracted entries; Authenticode certificate on ollama.exe is valid, signer Ollama Inc. Full CUDA package download was stopped; it is not required by the Vulkan distribution used locally.
- After the user enabled full access, Ollama started successfully, cloud mode was disabled, and Vulkan detected the RTX 4060 Laptop GPU. Qwen3.5 9B weights finished downloading and real inference was run.
- Authenticated Git access verified. Implementation pushed to `feat/local-cqa`, connected to the existing `main` history. Existing `backend/cqa-api` branch was preserved.

## Not yet demonstrated
- Comprehensive semantic model quality and repeatability across the complete dataset. Actual inference now works, but manual inspection found incorrect criterion decisions; see the live-check notes below.
- Ground Truth accuracy: official reference answers were not provided; no accuracy percentage is asserted.

This record distinguishes engineering tests from actual model validation. Update it after completing the outstanding checks.

## Supplied frontend integration: 2026-11-08
- The `hacaton.zip` UI is the default page. Its mock server/results were excluded; an adapter uses the existing validated local API. `/classic` preserves model settings, manual JSON import and history inspection.
- All 26 tests pass, including adapter regressions for reviewed answers during a second appeal, exact rubric polling, stale transcript rejection, source evidence, ISO timestamp alignment and one durable batch for all dialogs.
- Chrome checks confirmed 65 real records, a Kazakh conversation, eight editable criteria, and a 390px mobile viewport without overflow or runtime errors.
- An isolated browser fixture exercised 85.38 -> appeal -> reviewed 70 -> reload -> changed weight -> fresh full evaluation. These fixture outputs are isolated from production state and are not model quality measurements.

## Jury scenarios and real inference: 2026-11-08
- Added original AI gross-violation filtering, transcript/ID search and language filtering. A later manual review does not remove the original AI finding from this filter. Unevaluated dialogs are excluded.
- An initial real run was rejected for output length/missing evidence. Structured output now bounds explanations and requires source IDs; rejected outputs were not converted into fabricated scores.
- Local Qwen3.5 9B produced complete evaluations for RU/KZ/EN examples in about 17–25 seconds each, using the laptop GPU. This demonstrates the inference path, not agreement with expert reference answers.
- Real example `p1-ru-022` was flagged for a proposal to transfer funds personally to the operator. Browser verification exercised the actual saved model output, filter, explanation and navigation to its source. Separate synthetic UI fixtures remain isolated.
- Manual reading of these real outputs found semantic mistakes (notably N/A and a contradictory greeting explanation). Treat them as reviewable AI proposals; no accuracy percentage or perfect rule adherence is asserted.
- See `docs/demo.md` for the five-minute live demonstration and preflight checks.
- All 27 automated tests pass. The browser also verified gross-filter/search/language composition and real-model source navigation.
- A real voice-call transcript was evaluated successfully. A separate reasoning-mode experiment exhausted 5,000 tokens without a final response; that mode was not enabled in production. Changing sampling parameters alone did not eliminate semantic N/A errors, so no quality improvement is claimed for those experiments.

## Audio workflow and focused scoring: 2026-11-08
- Added local audio upload, persistent serial CPU transcription/diarization, review drafts, explicit roles, role overrides and source-bounded splitting of merged speech. Confirmation creates an ordinary versioned `AUDIO` conversation; original recognition remains separate.
- Local Whisper Small, sherpa-onnx 2.0.1 pyannote segmentation and WeSpeaker embeddings installed. Model setup records sources and hashes; inference is offline. Speaker clusters are proposals, not automatically assigned operator/client identities.
- The supplied 108.86-second OGG was actually uploaded through the application and processed in about 84 seconds. The native player successfully requested a byte range from the canonical WAV (206); the draft, unset roles, desktop/mobile layout and source playback were checked in Chrome. The monologue was left for role confirmation, not presented as a fabricated client/operator conversation.
- ASR/diarization and playback use the same reference PCM. A real PyAV container test confirmed 1 second speech + 1 second timestamp gap + 1 second speech remains 3 seconds. The original compressed file is retained separately. Atomic attempt-specific artifacts prevent orphan workers from replacing a confirmed source.
- Partial ASR chunks from the same confirmed speaker/role are grouped for scoring so a pause does not split the first operator reply. Review can split one mistakenly merged acoustic segment into contiguous source-time children with independent roles; fixtures and real API-route integration verified preservation after reload/publication.
- Enabled semantic-fingerprint-guarded fact checks for the unchanged contact, clarification and consultation criteria. Custom semantic edits use the current generic evaluator; c7 was not replaced after its holdout regression. See `docs/quality-experiment.md`: the reference labels are self-authored and require independent expert review.
- Real integrated RU/KZ/EN scoring completed in about 30–37 seconds per short dialog. RU001's contradictory contact and consultation/N/A decisions were corrected; this is not evidence of general accuracy. All inference stages and token use are stored.
- Remaining work for quality: independent team labelling and fresh family-held-out comparison, especially closing, missing context and valid escalation. ASR/diarization mistakes remain visible and manually correctable; no overall accuracy percentage is asserted.
- Final verification: 38 Node tests and 5 Python alignment tests pass; audio browser/API journeys and the existing scoring/appeal/checklist workflow pass. Scoped independent review found no remaining P1/P2 in source-bounded split handling after fixes.
