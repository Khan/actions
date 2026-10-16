---
"review": minor
---

Every approval now opens with a visible verdict line. Before, an approval whose findings were all minor (no medium and no blocking ones) posted with an empty head whenever any of them posted inline, on the theory that the inline comments were the review. The body then showed only its collapsed folds, so the author saw no "approved" text at all. Now the APPROVE head always says nothing blocks, and when the run had findings it counts them and says where they are:

-   No findings: "**✅ Approved** — nothing blocks." (was "**✅ Approved** — no blocking issues found.")
-   Minor findings only: "**✅ Approved** — nothing blocks; 3 minor findings (see inline comments)." The pointer reads "listed below" when the findings are in the body (collapsed into its fold, or PR-level lines under the head), and "2 inline, 1 listed below" when they split. It deliberately does not name the observations section, which a body holding only PR-level findings does not have.
-   Medium findings: unchanged, "**✅ Approved** — nothing blocks; N findings worth fixing before merge (…)." Minor findings are not added to this head.

`renderReviewBody` takes two optional counts, `inlineFindingCount` and `bodyFindingCount`. The latter replaces the `hasBodyFindings` flag the demoted-COMMENT head used. `submission.ts` passes both; the eval runner's replica passes `inlineFindingCount` only, since it has no body-findings surface. Nothing parses the head. The redundant-approval skip and the conformance gate compare against the same renderer's bare approve line, so neither changes behavior. The `review details` fold, the fingerprint stamp, and the observations list autofix reads are byte-identical.

Expected output-shape effect: inline comments, review events, and the folds are unchanged. Every approval with only minor findings, at least one of them inline, gains a one-line head of about 70 to 100 characters where its body had none; this is the common shape of an approval that leaves suggestions or nits. An approval whose findings all collapsed into the body changes its head wording (about 20 characters longer). A finding-less approval's head is 10 characters shorter. REQUEST_CHANGES, HOLD_FOR_HUMAN, COMMENT, and medium-finding approvals are byte-identical.
