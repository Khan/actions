# Validator-only fidelity baseline

This replay measures whether the unchanged claim-validator corrects inaccurate details without dropping a useful finding or damaging an already-correct comment. It runs the three historical comments from [claim-fidelity.md](./claim-fidelity.md) and their three hand-authored clean controls through the same validator prompt. It does not run the finding producers or change production validation.

## Inputs and isolation

The host fetches full files from `Khan/webapp` at each review's original commit and the parent of the PR's first commit. Existing evidence hashes must match. Additional cited callers and definitions are fetched at the same commits and receive hashes in the snapshot manifest. Missing base files are treated as additions only after a 404 response. Other fetch failures stop preparation.

Preparation currently covers 15 reviewed files and 13 existing base files across the three cases. The two remaining files were added by the coaching PR. Source files are not synthesized from the evidence excerpts.

Each sample receives its own partial checkout, the diff between those base and reviewed files, minimal PR metadata, and one candidate with the neutral id `candidate-1`. Both original and clean-control samples use the same code and diff. Source manifests, expected outcomes, controls, other samples, and transcripts are outside that sample's readable root. The cached bytes are checked again before staging.

The validator uses the existing SDK runner with Read, Grep, and Glob. The runner's path guard scopes those tools to the sample. A live read-scope probe must pass before any validator sample runs. An unproven or failed probe stops this experiment rather than switching runners or changing permissions. The labels identifying original and clean-control inputs appear only in the host-side report.

This is a bounded-context experiment, not a complete reproduction of the original review. It includes the named files and nearby callers, not the full repo. Original PR metadata, skills, and the investigation-cap CLI are not staged. Required runtime imports resolve through the existing eval's missing-import fallback. Record requests for missing context in the transcript audit rather than reading a failed investigation as proof that the concern is wrong.

## Measurement

The default is 3 repeats of each of 6 inputs, or 18 validator calls, plus one read-scope probe. Original and clean-control ordering alternates across repeats. The model comes from the selected `review.md`, without a model override. Each validator call has a 12-turn limit and a 180,000 ms timeout.

The report carries the model, prompt hash, lexical scorer hash, implementation hash and file list, input and source hashes, tool-policy version, full validator output, SDK accounting, rendered comment, verification state, retention, unexpected blocking, and the four component checks. The implementation hash covers request preparation, the SDK runner and read guard, accounting, production verification and rendering, their supporting modules, and dependency config. A missing or invalid verification is an error, not a retained finding. A valid refutation is a scored dropped finding. Errors and budget skips remain separate from scored samples. Checkpoints are written after each sample, including skips and failures.

The `--max-usd` value is a stop-before-next-dispatch threshold at reported list cost, not a hard total ceiling. An in-flight call may overrun it, and the read-scope probe is separate. An unpriced dispatch failure stops further calls and marks the spend incomplete, including the SDK runner's zero-cost sentinel for missing pricing. Known spend from earlier calls remains recorded. The default threshold is $8. No price or success is inferred from a failed call.

The rendered body is the bare `renderClaimComment` output, without attribution or submission placement. Equality with a recorded body here does not mean exact publication-byte equality. The frozen live evidence retains its original fields and hashes.

The component checks are lexical regression checks. Read at least one transcript for every case and input kind, then audit every changed or flagged comment against the pinned source. A paraphrase can fail a regex despite being correct, and passing regexes do not prove arbitrary supporting claims true. Report audited outcomes separately from lexical scores. Do not treat the 18 correlated samples as a population-level improvement estimate.

The output scorer extracts JSON once using production's `parseJsonObject`. Both the duplicate-id guard and `parseValidatorOutput` consume that selected object. A valid fenced payload followed by an unrelated object is scored from the fence. Duplicate ids in that fence remain errors even when a trailing object contains one valid id. Error samples retain their raw output and known spend rather than disappearing from the report.

## Run

From this branch's repo root, prepare and verify source without calling a model:

`node -r @swc-node/register workflows/review/eval/validator-fidelity-live.ts --prepare-only`

Run the unchanged validator in a terminal where `ANTHROPIC_API_KEY` is already configured:

`node -r @swc-node/register workflows/review/eval/validator-fidelity-live.ts --repeats 3 --max-usd 8`

The CLI prints its output directory. It refuses to overwrite an existing report, including a partial or blocked report. Use a fresh directory with `--output-dir` when choosing one explicitly. Transcripts and staged source remain alongside the report for audit.

A later candidate prompt can be selected with `--review-md <path>`. Before comparing its report with the baseline, check that model, scorer, implementation hash and file list, input/source hashes, tools, repeat count, and budgets agree. An absent implementation hash is incomplete provenance, not a match. Audit implementation differences explicitly or rerun the baseline before treating a later comparison as prompt-only. No candidate prompt is included here. Only consider adding a component-by-component validation rule after the baseline demonstrates missed inaccuracies, and reject any candidate that loses useful findings or damages clean controls.

## Verified so far

- The new harness has 22 deterministic tests covering source hashes, staged diffs including added files, read-scope boundaries, blinded inputs, corrected controls, malformed and duplicate outputs, retention, unexpected blocking, repeated inputs, checkpoints, budget skips, unusable costs, implementation fingerprint coverage, and exact replay of the 18 recorded live outputs.
- The full suite passes 2,446 tests in 128 files. Lint and a targeted strict typecheck of the replay modules and tests pass.
- Source preparation succeeded for all three pinned reviews, including the full-file hash checks.
- The initial sandbox attempt stopped before any model call because it had no `ANTHROPIC_API_KEY`. `validator-fidelity-preparation.json` preserves that initial preparation and blocked attempt.
- A subsequent terminal run completed all 18 samples with the unchanged validator at $7.791942 reported list cost, plus the separate scope probe. All findings survived without unexpected blocking, but the manual audit found supporting-claim and headline misses, new citation errors, and lexical scoring disagreements. See [the live baseline audit](./validator-fidelity-baseline.md) and [recorded outputs](./validator-fidelity-baseline.json). No candidate prompt has been run and no production-quality improvement is claimed.
- After the harness review fixes, an offline replay using the operator's cached run artifacts reproduced all 18 staged contexts, resolved prompts (after normalizing the stage path), input hashes, scores, and rendered comments. `validator-fidelity-followup.json` records that check with the new implementation fingerprint. No model calls were made, and the original live report wasn't rewritten. This checks the effect of these source changes, not the original runtime environment or a future model run.
- The JSON-selection follow-up adds 3 regression cases (25 validator fidelity tests total). All 18 frozen outputs still reproduce their input hashes, lexical scores, and bare rendered bodies after inheriting the label-preservation changes. This check reads the committed outputs only, not cached source or resolved prompts, and does not regenerate the paid baseline or the earlier follow-up report.
