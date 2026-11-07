# Local scoring quality experiment (2026-11-08)

This is a small, manually audited development experiment, **not official Ground Truth validation**. No production evaluator or saved evaluation was changed. Inputs and outputs remain under ignored `.local/quality-v2/`.

## Design and scope

- Confirmed stored rubric version 2 has exactly the same criteria as default version 1.
- Local Qwen3.5:9b, digest `56671c2ab9385f9cfcb404638e32cd62d88e3501d44822208363c010179a3c90`, Ollama 0.40.15. Local model metadata checked before inference. No cloud calls.
- Frozen self-authored labels for c1, c2, c4, c7 across three calibration dialogs and six held-out examples: three distinct DEV families and three authored RU/KZ/EN examples. These labels require independent human review.
- Baseline is existing joint eight-criterion prompt: saved live outputs for calibration, fresh calls for holdout. Proposed method uses four independent calls, each returning a short observation and source IDs before factual predicates; code applies criterion Boolean logic and N/A mapping.
- Calibration exposed a closing failure: even isolated Boolean judgment treated original advice/client thanks as an operator closing recap. Only c7 was refined before holdout to extract separate exact closing recap, further-help and farewell phrases. Original calibration results are retained.
- No dialog ID, transcript hash, expected answer, or customer keyword is supplied to inference or mapping. Current default criterion semantics are explicitly represented; this is not a generic compiler for edited rubrics.
- All inferred answer/source IDs are checked with production `validateAnswers`. Combined evaluation scores use current rubric weights through production `calculateScore` (unmodified criteria retain baseline values).

## Important interpretation limits

The proposed latency is for **four focused criteria only**, while baseline latency covers all eight. Replacing only four answers after the existing full evaluator costs baseline time **plus** focused time. These figures do not demonstrate a faster complete evaluator.

c2 is audited using all information available before the first human operator response, including bot/client context. The wording “с самого начала” should be confirmed with a domain reviewer. c7 is audited literally: courtesy acknowledgement is not a summary or offer of further help. The synthetic no-request conversation is especially ambiguous for c2, so report sensitivity excluding that decision.

Known held-out residuals include missing-context c2 incorrectly returning N/A and valid collect-information/escalation next steps being underrated by c4. Exact source IDs alone cannot prove semantic correctness. Prompts sometimes produce Kazakh observations despite requesting Russian and truncate observations to schema maximum; do not assume explanation polish from schema validity.

## Artifacts

- `experiment-v1.mjs`: original four-predicate calibration protocol.
- `experiment.mjs`: frozen holdout protocol, with quote-based closing extraction.
- `references.json`: labels authored before model inference, explicitly marked unofficial.
- `calibration.json`, `holdout.json`: predictions, observations, usage, latency, metadata.
- `summarize.mjs`, `summary.json`: criterion-level comparison, score calculation, validation and exact operator-quote checks.

## Implementation recommendation

Treat these prompts as an experimental candidate, not proof of general accuracy. A production candidate can preserve the existing validated schema and weights, use independent evidence-first calls, and apply only logical combinations explicitly present in the live criterion. Exact-default semantics must be guarded by a semantic fingerprint excluding weights; semantic edits require a generic single-criterion prompt using the actual new description, scale and N/A rule. Always rerun the model for changed rubric semantics. Do not silently force changed rules through the default predicate mapping.

For c7, extract separate closing-act quotes and check they are exact substrings of operator messages. Keep speaker roles and closing position. For c4, a future candidate should separately represent the alternative “valid next step” rather than only a blended coverage category. Any such change needs new held-out cases rather than reusing these observed failures as proof.

## Measured result

| Criterion | Baseline holdout | Focused holdout | Focused mean time |
|---|---:|---:|---:|
| c1 contact | 5/6 | 6/6 | 2.55 s |
| c2 clarification / N/A | 0/6 | 5/6 | 3.63 s |
| c4 consultation / N/A | 1/6 | 4/6 | 4.55 s |
| c7 closing | 5/6 | 4/6 | 3.73 s |
| All four | 11/24 | 19/24 | 14.46 s |

These are exact matches to our small self-authored reference set, not official accuracy. Excluding the ambiguous synthetic no-request c2 decision gives 11/23 baseline versus 18/23 focused. On the three real held-out DEV dialogs only, baseline is 4/12 and focused is 7/12; synthetic cases contribute 7/12 and 12/12 respectively. This gap is a reason for caution.

Baseline eight-criterion mean latency was 20.28 s (range 15.08–24.16); focused four-criterion mean was 14.46 s (9.98–18.58). A hybrid baseline-plus-four-pass evaluation would average 34.74 s. Initial calibration included a 25.64-second first focused request, probably model/context warmup; no warmup-adjusted speed claim is made.

Calibration before closing refinement matched 9/12 versus baseline 3/12. Quote-based closing recheck subsequently matched all 3 calibration c7 decisions, but degraded held-out c7 from 5/6 to 4/6. **Do not promote the new c7 solely on calibration results.**

All 36 focused decisions across initial calibration and holdout passed `validateAnswers`; combined full evaluations passed again through `summarize.mjs`. All extracted nonempty closing phrases in holdout are exact substrings of operator messages. This verifies source integrity, not interpretation. Three additional closing-only calibration calls completed with valid IDs.

## Recommendation after observing results

The focused c1/c2/c4 prompts are promising candidates for review-assisted evaluation; the evidence is insufficient for autonomous scoring or a broad accuracy claim. Do not enable the new c7 extraction by default from this experiment: it introduces a held-out regression. Selecting c1/c2/c4 after seeing holdout is a post-hoc choice and requires fresh validation.

Do not copy the model's free-text observation directly into a production explanation without consistency review. The observation sometimes contradicts extracted facts (e.g. says a recap happened while the recap quote is empty). Generate concise explanations from validated facts and quotes for Boolean criteria, or reject contradictory output; deterministic explanations must use the same live rubric semantics.

The concrete prompts, schemas, enum mappings, local request settings and reference cases are ready for adaptation in `.local/quality-v2/experiment.mjs`. No further model runs were launched beyond this bounded experiment.
