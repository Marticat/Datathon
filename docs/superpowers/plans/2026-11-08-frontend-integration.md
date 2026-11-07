# Supplied frontend integration

Goal: use the supplied hacaton.zip interface as the default CQA workbench, backed by the existing real local inference API.
Architecture: keep validated server/domain/storage; browser adapter translates the supplied component's requests into versioned rubrics, persistent jobs and evaluation-scoped appeals. Preserve the existing workbench at /classic for model settings, JSON upload and historical inspection.
Ruling: replace only the presentation and bridge its API. The archive's fake evaluations and data/store.json are not production inputs. Keep each full rubric version isolated, including weight-only edits. Original timestamps and source evidence remain visible. No simulated audio playback.

- [x] Add adapter tests for rubric conversion, NA/scale/flag values, current transcript/rubric isolation, persistent evaluation jobs and appeal identity.
- [x] Integrate supplied assets, local host styling and module initialization; remove unavailable/external resources and inline scripts.
- [x] Adapt component for fresh full evaluations, explicit NA rules, durable jobs, complete evidence, real audio and stable reloads.
- [x] Run full tests and browser workflows against isolated fixtures and real local state; inspect desktop and mobile layouts.
- [x] Review final changes and publish to the user-requested main branch after checks.

Verification: 26 automated tests, syntax checks and isolated full browser workflow pass. Real DEV (65), KZ and mobile layouts verified. Independent review findings addressed.
