# Useful findings with incorrect details

The eval previously counted these three useful findings as caught without distinguishing an incorrect fix, a false supporting assertion, or a visible line that hid the consequence. It also discarded validator corrections. The change here fixes that replay gap, not the reviewer's judgment.

## Reviewed source

Each `fidelity.json` sidecar preserves the original posted comment, the author's reply, and raw source excerpts with commit-pinned urls, line ranges, and whole-file SHA-256 hashes. The review object's `commit_id` matches the comment's `original_commit_id` in all three cases. The comment's current `commit_id` differs in two cases because github relocated the thread after later pushes. It is not the source used for these expectations.

| Thread | Review | Reviewed commit |
| --- | --- | --- |
| [webapp#41989, 3926287619](https://github.com/Khan/webapp/pull/41989#discussion_r3926287619) | 5104057240 | `ec472f1619848fa78e8383b64ebb0d73a67a3756` |
| [webapp#41896, 3925652967](https://github.com/Khan/webapp/pull/41896#discussion_r3925652967) | 5103292019 | `dd7693df7ec1ed308011b1a0e9c9b0c9831b6d82` |
| [webapp#42001, 3934967849](https://github.com/Khan/webapp/pull/42001#discussion_r3934967849) | 5114173827 | `5b4a84fbb520c3102467ed549078c72aff3cdd93` |

The base excerpts come from the parent of each PR's first commit, not current main. The github broker did not allow the compare endpoint, so source verification used raw files fetched at those base and reviewed commits.

- In #41989, `getEmailableDistrictsByCountry` loads all District entities matching `country_code` before applying eligibility checks. The prior read used keys derived from admin UDIs. The model declares `DontSendKADEmails` with `datastore:"dont_send_kad_emails,noindex"`, while `IsTest` and `RosterSyncingEnabled` lack that tag. The read-size concern survives. The claim that all eligibility fields are indexable does not, and adding an index config entry alone is not the proposed query fix. The control keeps paging with a cursor and preserves eligibility checks and recipients. Filtering indexed fields can reduce work but does not impose a page bound.
- In #41896, `ManyCoachedBy` starts one relationship lookup per student and returns the group error alongside its results. `ManyCoachedByActorErr` returns its still-empty map on any error, and the new loader broadcasts that error to every key. The batched acl then falls through to the admin check. `writing_coach_platform_assignment.go` reaches this check and returns unauthorized on failure, so a plain teacher can lose access to healthy rows after one student's lookup fails. The batch concern survives the author's reply about a single service call because that call contains per-student operations. `IsCoachedByActorErr` exists as a cached function variable at lines 36-40, and the bool helper calls it. The control uses that existing helper for a per-key fallback on the failure path. It does not claim to repair a service-wide outage or grant access on error.
- In #42001, the phantom-user branch follows a successful `RequestUser` call. Its `err` is nil, and `errorToDebugMessage` explicitly returns nil for nil input. There is no nil panic or authorization bypass. With a nonempty classroom list, the branch returns `UNAUTHORIZED` with a null debug message even though it constructs an unauthorized error for logging. The optional diagnostic reason is the concern, not the safety of the nil argument. The existing sketch is sound. The control changes only the visible subject to name that consequence and remains non-blocking. No dependency on that optional field is assumed.

These are reconstructed finding envelopes around exact posted prose, not recovered producer or validator artifacts. Confidence, failure scenarios, and finding ids are replay metadata. The sidecars retain the exact original comments separately. Source excerpts establish the named mechanisms, not every incidental assertion in the comments.

## Separate checks

`claim-fidelity.ts` scores four components independently: `mainDefect`, `proposedFix`, `supportingAssertions`, and `visibleConsequence`. It reads the rendered comment, including sketches. For the visible check it reads only the text before the context block, so hidden evidence cannot repair a misleading headline. It never substitutes `evidence_trace` or `failure_scenario` for posted text.

The checks are bounded lexical regressions over these examples, not a general semantic judge. Required regexes allow equivalent wording, and forbidden regexes identify the known bad assertions. They do not establish arbitrary prose's factual correctness or handle every paraphrase or negation. Each finding remains a `mustCatch`, never a whole-finding `mustNotPost`. Removing a finding loses recall and fails all four component checks.

The `control` objects are explicitly hand-authored validator outputs. They establish what the harness must preserve when a validator makes a correction, not whether a model would produce it. The cases are recorded-only, not live-enabled PR snapshots. They contain source excerpts rather than complete checkout trees.

## Baseline and measured result

Baseline code: `a5b6eb08efd60b690f443b569f552404e731497a`. The untouched suite passed 2,220 tests in 106 files before any eval implementation changes. The initial regression run then failed the three correction replays and the live producer's subject/body parity test. After adding malformed-correction guards and formatting, the final identical tests and fixtures were also run in a detached baseline worktree. That run had 35 passes and 7 failures out of 42 focused tests. The candidate passed all 42.

`claim-fidelity-results.json` records both implementations against the same final scorer and fixture hash. The original comments and hand-authored corrections are identical in both arms. Its `reviewFollowup` section repeats the measurement after unifying the renderer and records the expanded implementation file list, including production verification, rendering, and their supporting modules. Earlier implementation hashes covered only three eval modules and aren't directly comparable to the expanded hashes.

| Observable | Baseline | Candidate |
| --- | --- | --- |
| Original findings caught | 3/3 | 3/3 |
| Original golden precision | 3/3 | 3/3 |
| Original noise | 0/3 | 0/3 |
| Original main-defect checks | 3/3 | 3/3 |
| Original proposed-fix checks | 2/3 | 2/3 |
| Original supporting-assertion checks | 1/3 | 1/3 |
| Original visible-consequence checks | 2/3 | 2/3 |
| Hand-authored correction component checks | 8/12 | 12/12 |
| Hand-authored corrections retained | 3/3 | 3/3 |
| Original comments byte-equal to production rendering | 1/3 | 3/3 |
| Corrected comments byte-equal to production rendering | 0/3 | 3/3 |

The original comments still fail the same four checks. Editing fixtures did not make them better. The measured change is that the eval now represents corrections which production already applies. The production prompt, validator, and prose judge are unchanged. There were no model calls, so this provides no measured improvement in reviewer quality, recall, or model correction rate.

## Implementation and verification

- `live-producer.ts` uses production's subject/body composition and claim builder, then carries `corrected` through validator parsing.
- `corpus/loader.ts` preserves correction objects. Invalid field values still go through production's field guards at application time.
- `runner.ts` renders every candidate with production `renderClaimComment`, including uncorrected and plausibly downgraded findings. This keeps suggestion/sketch handling consistent across the compared outputs. It applies confirmed corrections with production `applyVerifications`. The normalized finding also receives the corrected prose, summary, suggestion, and anchor, so downstream matchers and judges receive the corrected posted text. Producer evidence and failure scenarios stay unchanged as provenance. Plausible corrections remain unapplied, matching production's current behavior.

Run the focused tests from the repo root:

`pnpm test --run workflows/review/eval/claim-fidelity.test.ts workflows/review/eval/live-producer.test.ts workflows/review/eval/live-producer-fidelity.test.ts`

Print the deterministic report, without model calls:

`node -r @swc-node/register workflows/review/eval/claim-fidelity-report.ts`

The initial candidate passed 2,244 tests in 107 files. After rebasing onto `088b1a1`, the full suite passes 2,418 tests in 126 files and `pnpm lint` passes. The same scorer and fixtures produce identical component results after the rebase. The live-producer fidelity test moved to its own file with shared test fixtures to stay under the repo's 1,000-line limit. `pnpm typecheck` passes but its tsconfig excludes `workflows/`. A separate strict check including the changed eval modules reports the existing `runner.ts` error where `submitEvent` may return `COMMENT` but `PlannedReview.event` excludes it. The same error reproduces in the detached baseline worktree. This change does not fix that unrelated type mismatch.

The review follow-up passes 2,424 tests in 127 files, lint, and the repo typecheck. Six added tests cover accepted label/line corrections in both severity directions, drop-in versus sketch rendering before validation, and implementation hash coverage. The strict eval check still reports only the existing `COMMENT` mismatch. The repeated deterministic measurement keeps the same component scores, with all 3 original and all 3 corrected comments now byte-equal to production rendering.

Before changing a model prompt, run the same reviewed code and candidate claims through both prompt versions with the same tools, model, budget, and component checks. Measure whether inaccurate details are corrected and whether the useful findings survive. These recorded controls are not a substitute for that experiment, and whole-review live A/B rates from the old harness should not be compared to new rates as if only a prompt changed.
