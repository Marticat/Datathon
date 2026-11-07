# External conversations and judge readiness

**Goal:** Download a small attributed Perit/ABCD test pack, run actual local inference, identify concrete failures, and make a clean checkout straightforward for judges to launch and inspect.

**Architecture:** Keep external examples in separate groups, never DEV/PROD. Preserve source IDs, licenses, revisions and hashes; audio adaptations must be documented. Store no fabricated quality labels. Use the real local ASR/LLM path; retain original results when fixing defects.

**Constraints:** Existing main branch per user request. Node 20.20+, Ollama 0.40.15+, local inference only. Preserve running DEV queue and all completed results. User's deleted voice note must stay deleted. Existing private datasets/keys stay ignored.

- [x] Acquire two short complete Perit recordings and three ABCD sample conversations with provenance and licenses. Add reproducible source preparation/import instructions.
- [x] Run actual audio transcription and review speaker/text/time alignment; confirm roles from source evidence. Run all examples through official quality evaluation and record limitations without claiming official Ground Truth.
- [x] Audit clean startup and dependencies; add actionable preflight/launch guidance and verify on isolated fresh state.
- [x] Exercise jury-facing UI: fresh import, score/evidence, gross filter, appeal/review, checklist version/change, audio review and missing-record recovery. Fix reproducible blockers.
- [ ] Run regression and fresh-checkout checks, independent review, commit/push tested changes to main. Monitor DEV and preserve its export workflow.

**Review focus:** missing models, wrong Python, absent .env or API URL, no demo data on fresh checkout, media paths/role mapping, stale scores after changes, private data accidentally committed, sample data mixed into submission.
