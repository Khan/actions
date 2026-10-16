---
"review": minor
---

Every approval now opens with a visible verdict line. Before, an approval with no medium (and no blocking) findings posted with an empty head whenever any minor finding posted inline, on the theory that the inline comments were the review. The body then showed only its collapsed folds, so the author saw no "approved" text at all. Now an approval with no medium findings always opens with "**✅ Approved** — nothing blocks.", whether or not minor findings posted inline or collapsed into the body. The head reports only what blocks or is worth fixing before merge; minor findings stay where they post. This replaces the comment-less approval's old "**✅ Approved** — no blocking issues found." The medium-findings head is unchanged.

Nothing parses the head. The redundant-approval skip and the conformance gate compare against the same renderer's bare approve line, so neither changes behavior. The `review details` fold, the fingerprint stamp, and the observations list autofix reads are byte-identical.

Expected output-shape effect: inline comments, review events, and the folds are unchanged. Every approval with no medium findings and at least one inline comment gains a one-line head (32 characters) where its body had none; this is the common shape of an approval that leaves suggestions or nits. Every other approval with no medium findings keeps a one-line head that is 10 characters shorter. REQUEST_CHANGES, HOLD_FOR_HUMAN, COMMENT, and medium-finding approvals are byte-identical.
