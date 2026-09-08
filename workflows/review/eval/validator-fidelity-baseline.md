# Unchanged-validator live baseline audit

The unchanged validator retained all 18 findings but didn't consistently remove inaccurate supporting claims or make the visible summary explain the consequence. This establishes a baseline for a candidate experiment, not an improvement in production review quality.

[validator-fidelity-baseline.json](./validator-fidelity-baseline.json) preserves all 18 raw validator outputs, accounting, rendered comments, and original lexical scores. The full report and transcripts remain in the operator's run artifacts. Their hashes identify the audited bytes. The harness ref is recorded from operator context because this runner didn't capture an implementation hash. It must not be treated as run-attested provenance.

## Run and source checks

- Model: `claude-opus-5`, unchanged validator prompt.
- 3 cases, original and clean-control inputs, 3 repeats each. All 18 scored, with 0 errors or skips.
- Reported list cost: $7.791942 for the 18 validator calls. All dispatches reported positive cost. The separate probe reported $0.048, rounded in its detail string.
- All 28 cached source blobs match the snapshot hashes: 15 reviewed files and 13 base files. All 18 staged claims match their input hashes, and every staged reviewed file matches its snapshot.
- The current extracted prompt and lexical scorer match the run's recorded hashes. Source commit pins are in [validator-fidelity-preparation.json](./validator-fidelity-preparation.json).
- Scope probe passed. The samples made 164 tool calls, with 8 denied reads and 1 denied tool call. The transcript records the attempted bigquery call being denied before execution. Out-of-scope read results contained denials, not source content. These observations support this run's isolation, not a general guarantee about the SDK's ambient tool configuration.

## Original lexical scores

The four facet columns count passing samples, not verified facts. Retention and unexpected blocking use production verification and rendering rules.

| Input | Retained | Confirmed | Plausible | Main defect | Proposed fix | Supporting assertions | Visible consequence | Unexpected blocking |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Original | 9/9 | 9/9 | 0/9 | 9/9 | 8/9 | 8/9 | 4/9 | 0/9 |
| Clean control | 9/9 | 6/9 | 3/9 | 9/9 | 9/9 | 9/9 | 9/9 | 0/9 |

## Manual audit

Read the validator outputs, rendered comments, and tool-call trails across the six input groups. Checked changed and flagged text against the commit-pinned files. The findings below distinguish the targeted assertions from additional errors noticed during that audit. They are not a certification of every incidental assertion in these long comments.

### Coaching batch: webapp#41896

Original samples are 1, 8, and 13. Clean controls are 2, 7, and 14.

- All 6 retain the supported concern: one failed lookup can cause the batch wrapper to discard successful results and deny healthy roster rows. Per-kaid fallback on the error path leaves the happy path unchanged.
- Samples 1 and 13 remove or correct the nonexistent-helper assertion. Sample 8 still says `acl.IsCoachedByActorErr does not exist` inside its sketch. The helper is a cached function variable in [coaches.go at the reviewed commit](https://github.com/Khan/webapp/blob/dd7693df7ec1ed308011b1a0e9c9b0c9831b6d82/pkg/khan/acl/coaches.go#L36-L40). This is 2/3 corrections of the targeted supporting error, not 3/3 fully accurate comments.
- Sample 8 introduces a citation to `writing_coach_session_loader.go:131-138`. That file has only 90 lines at this commit. The relevant comment is at [lines 70-73](https://github.com/Khan/webapp/blob/dd7693df7ec1ed308011b1a0e9c9b0c9831b6d82/services/ai-guide/essay_feedback/loaders/writing_coach_session_loader.go#L70-L73).
- Clean-control sample 14 passes every regex but moves the quoted failure comment to line 44. It's actually at [line 40](https://github.com/Khan/webapp/blob/dd7693df7ec1ed308011b1a0e9c9b0c9831b6d82/services/ai-guide/essay_feedback/loaders/coaching_loader.go#L38-L45). Clean-control retention therefore doesn't establish absence of damage.
- Several originals remove the test citation after failing to find it in the partial checkout. That search alone cannot establish repo-wide absence. A separate reviewed-commit listing of the loader directory contains no test file, but this audit doesn't claim an exhaustive repo-wide test search.

### District query: webapp#41989

Original samples are 3, 10, and 15. Clean controls are 4, 9, and 16.

- All 3 originals correct the targeted indexing error. `DontSendKADEmails` is [stored with `noindex`](https://github.com/Khan/webapp/blob/ec472f1619848fa78e8383b64ebb0d73a67a3756/services/districts/models/district.go#L86-L92), so an index.yaml entry alone can't make it filterable.
- Samples 3 and 10 still present indexed equality filters as an alternative that bounds the read. Those filters can reduce the result set, but don't impose a cap. Sample 10 passes the proposed-fix regex because it also mentions paging. That's a false positive for the complete proposed fix. Sample 15 correctly distinguishes narrowing from a limit and cursor that bound a page.
- Visible-consequence checks reject samples 3 and 15. Both describe the country-wide read before in-memory eligibility filtering. Sample 15 explicitly says the whole country's districts load as full entities. These are acceptable consequence-bearing paraphrases that the regex misses. Sample 3 is less explicit, but still names an unlimited country-wide read and in-memory filtering. The recorded scores are unchanged.
- The old code did an unbounded global admin-UDI query, then fetched the districts referenced by those UDIs. The new code queries all districts in one country, including districts without an admin UDI. These are different populations. Sample 3's categorical claim that the district-side read is narrower isn't established by the source. Actual total read volume and operational severity need data, not an assumed ordering of these sets.
- All 3 clean controls become `plausible` at confidence 0.4. Their proposed corrections are ignored by production's confirmed-only correction rule, so their rendered text stays unchanged. This preserves the clean comments but doesn't validate the reasoning behind the downgrades.
- The downgrade reasons correctly flag that page-per-invocation processing would require caller changes, and that actual district counts aren't known. They also claim that the new read must be smaller, which isn't established. Sample 16 explicitly cites missing `crud.GetAll` implementation context. Don't classify these as pure prompt failures without accounting for the partial checkout.

### Phantom-user debug reason: webapp#42001

Original samples are 5, 12, and 17. Clean controls are 6, 11, and 18.

- All 6 retain the supported issue and fix. The nil check is safe. The [phantom-user branch](https://github.com/Khan/webapp/blob/5b4a84fbb520c3102467ed549078c72aff3cdd93/services/humanities/resolvers/writing_coach_config.go#L157-L181) returns `UNAUTHORIZED` without the debug reason because it passes the already-nil error instead of reusing the unauthorized error.
- All 3 original headlines remain unchanged. They report a guaranteed-nil argument without explaining the missing debug reason. The correct folded discussion doesn't repair the visible headline. That's 0/3 targeted headline corrections.
- All 3 clean headlines remain consequence-bearing. No regression was found in this group's rendered comments.

## Decision

A small, eval-only candidate rule is justified: independently check the defect, proposed fix, supporting assertions including sketches and citations, and the visible summary. Correct unsupported details without discarding a supported concern. Judge the visible line independently of its folded discussion.

Don't change production validation on this evidence alone. Keep the original lexical scores frozen, carry the audit disagreements into the candidate comparison, and audit new assertions as well as the three known errors. Require useful findings to survive and clean controls not to acquire factual errors. Three repeats on three selected cases are a targeted check, not a population-level performance estimate.

CI has separately identified harness gaps: incomplete implementation fingerprints, acceptance of unpriced zero-cost dispatches, missing added-file staging coverage, mixed renderers in the broader eval, and missing accepted label/line correction coverage. Those should be resolved separately from any prompt experiment. The zero-cost gap didn't affect this run because all 18 dispatch costs were positive. Any implementation or source-context change between arms needs an explicit comparability check rather than relying on the lexical scorer hash alone.
