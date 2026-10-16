---
"review": minor
---

Every approval now opens with the same visible verdict line: "**✅ Approved** — nothing blocks." The head reports only blockers, and an approval has none. Before, an approval with no medium findings posted with an empty head whenever any minor finding posted inline, on the theory that the inline comments were the review. The body then showed only its collapsed folds, so the author saw no "approved" text at all. An approval with medium findings appended "N finding(s) worth fixing before merge (see …)" to its head. Both now read just "nothing blocks.", as does the comment-less approval that used to read "no blocking issues found." Medium findings still post inline ahead of minor ones, and they still never change the verdict. A conditional approval keeps its pre-merge-obligations pointer as a second line under the head.

`renderReviewBody` drops its `mediumCount` and `mediumInlineCount` inputs. `submission.ts` and the eval runner's replica stop passing them, and the medium count stays in the plan's notes and the verdict reasons. The README and the contract docstrings no longer say the approval head counts mediums. The reviewer and claim-validator prompts are deliberately unchanged, so nothing shifts how the models grade importance; their mention of the head counting mediums is now stale, and a prompt update can follow as its own evaluated change. Nothing parses the head. The redundant-approval skip and the conformance gate compare against the same renderer's bare approve line, so neither changes behavior. The `review details` fold, the fingerprint stamp, and the observations list autofix reads are byte-identical.

Expected output-shape effect: inline comments, review events, and the folds are unchanged.

-   An approval with no medium findings and at least one inline comment gains a one-line head (32 characters) where its body had none. This is the common shape of an approval that leaves suggestions or nits.
-   An approval with medium findings loses its "N finding(s) worth fixing before merge (…)" clause, a head about 60 to 90 characters shorter.
-   Every other approval's head is 10 characters shorter.

REQUEST_CHANGES, HOLD_FOR_HUMAN, and COMMENT bodies are byte-identical.
