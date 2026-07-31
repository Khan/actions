---
"review": minor
---

Cross-source dedup gains a second tier: a `claim-clusterer` sub-agent names the
candidate comments that describe ONE defect, and `dedup.ts` verifies that
assertion and merges them. Several reviewers finding one problem now post once.

Run 30587343777 (webapp#41204) is the case. Four sources flagged one wrong doc
comment (`// Keeps at most 10 samples per key.` above `const maxSamples = 25`) at
window.go :8, :9, :8, :8, and `merges` recorded none of them; it was a FIRST
review at `depth: full`, so not a re-review artifact. Autofix later satisfied all
four with one rewritten comment, which is the proof they were one defect.

Replaying that run's own claims.json showed the similarity tier is not close to
reaching it. Three of the four share the EXACT anchor and still score
0.060-0.068 Jaccard against a 0.14 floor with 0-1 shared bigrams against a floor
of 4: an order of magnitude below the tier, so no re-derivation from the fixtures
gets there (the floor that admits 0.06 admits everything). Each reviewer wrote
the same defect in different words, and the terser the claim the less text
arithmetic has to work with. Nor can reweighting the text recover the
discriminator: the pairs dedup deliberately keeps apart share MORE salient
tokens than the real duplicates do (run 29943085279's AddDate issue and its
"central behavior never exercised" thought sit on one line and share AddDate,
MemoryTTLDays, 180, 15). Duplicates are "same ask, different words"; those are
"same facts, different ask", which is a semantic judgment.

So the unit of identity is now the defect, not the anchor. Tier 2 requires no
line agreement at all, which is what makes the same-defect-different-anchor shape
mergeable for the first time (one missing-test defect drew comments at three
anchors in run 29943085279); the line survives as tier-1 evidence and as the
survivor's posting anchor.

The model contributes identity only. Every merge rule stays in code, and the
clusterer must ground each group in the code element its members share, which is
then checked: a group whose `evidence` names no identifier, literal, or quoted
text is discarded, and so is a member whose own text never mentions it. Same
path and different sources are enforced as in tier 1, and only a NON-BLOCKING
copy may be absorbed on a model's word — with the survivor always the
highest-severity copy, a false tier-2 merge can cost an advisory comment and can
never lose a blocking finding or soften a verdict. The accepted price: one defect
flagged blocking by two sources in different words still posts twice unless tier
1 reaches it.

Degradation is soft in both directions. Fewer than two claims, or one source,
and the clusterer is never dispatched (no spend). A missing definition or an
unusable reply leaves the run on tier 1, exactly today's behavior, and surfaces
as a run warning plus a `clustering` block in `dispatch-result.json`
(`candidates`, `proposed`, `clusterMerges`, and every rejected member with the
rule that stopped it) rather than as an author-facing note: duplicate hygiene is
not a review dimension. Each merge in `merges` now carries `via`
(`similarity`/`clusterer`/`both`) and the merged copies' own anchors, and the
"also flagged by" note names a source's line when it differs from the survivor's,
so the merge rate reads off the artifact instead of off a PR that autofix has
already tidied.

The live A/B now runs dedup, which it never did: a change to the merge rules was
unmeasurable by construction before this. Tier 1 runs in both arms (it is shared
code and production has had it since #245) while tier 2 is carried by each arm's
own review.md, exactly like the provenance gate's anchor-snap emulation, so the
arm delta prices the clusterer alone and a false merge shows up as recall loss.
The report gains a "Cross-source claims merged (of candidates)" row with tier 2's
share, and per-case dedup counts.

`dispatch.ts` was at its 1000-line cap again, so the clustering step lands in
`dispatch-cluster.ts` (dispatch, contract parse, telemetry) rather than raising
the cap; the tier-2 tests live in `dedup-cluster.test.ts` and
`dispatch-cluster.test.ts` for the same reason.
