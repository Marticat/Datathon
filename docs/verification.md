# Verification record

Implementation session: 2026-11-07.

## Confirmed
- All 18 automated tests pass; JavaScript syntax checks pass.
- Organizer DEV endpoint successfully returned 65 records: 35 RU, 15 KZ, 15 EN. Imported into ignored local state.
- Server/API tests cover 85.38 arithmetic, NA and scales, separate gross violation flag, structured output validation, evidence IDs, UTF-8 chunk boundaries, actual on-disk persistence, appeals, fresh rubric versions, batch partial failures and historical transcript snapshots.
- Local inference adapter tests check rejection of remote aliases, runtime version enforcement, no input truncation/context shift, and digest provenance.
- Browser checks in installed Chrome: all 65 conversations load, KZ filter/editor work, 390px layout has no horizontal overflow, no JavaScript runtime errors. No production scores were fabricated for this check.
- Independent code review performed; original findings on metadata, truncation, UTF-8, job atomicity, provenance and UI deferred updates were fixed.
- Single-dialog evaluation also uses the persistent queue, avoiding browser timeouts while another dialog is running.
- Portable official Ollama 0.40.15 CPU/Vulkan runtime extracted. ZIP CRC verified for extracted entries; Authenticode certificate on ollama.exe is valid, signer Ollama Inc. Full CUDA package download was stopped; it is not required by the Vulkan distribution used locally.

## Not yet demonstrated
- Actual local model inference and RU/KZ/EN model quality. Ollama needs its standard user directory; the execution environment denied creation despite a scoped permission grant. User asked to start the prepared local script from a normal terminal.
- Ground Truth accuracy: official reference answers were not provided; no accuracy percentage is asserted.
- Push to private GitHub repository: requires authenticated connector or Git access. Code is prepared locally, without signed URLs or real transcripts in Git.

This record distinguishes engineering tests from actual model validation. Update it after completing the outstanding checks.
