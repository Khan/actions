---
"review": minor
---

review: replace the stripped hidden version marker with a visible code-rendered attribution footer

The `<!-- pr-reviewer:version -->` marker Step 7 instructed never posted:
gh-aw's safe-output ingest sanitizer deletes ALL XML/HTML comments
(`removeXmlComments`, the same strip that killed the fingerprint stamp),
verified on all 9 guidance comments and 13 review bodies posted to
Khan/webapp on 2026-08-11/12. Version and config attribution from the PR
surface was impossible.

Every submitted review body and the risks/patterns guidance comment now end
with a one-line `<sub>` footer (`<sub>` is on the sanitizer's allowed-tag
list) rendered in code by the new `lib/version-footer.ts`: release version
from the pinned checkout's package.json, finding-schema version, executed
re-review depth, the repo's re-review mode (blocking-only modifier included),
and the ROUTING enable list. A segment the staging cannot state is omitted,
never guessed. The submission CLI appends it to the body and stages
`version-footer.txt` for Step 7 to paste verbatim; the redundant-approval
skip compares the body minus the footer, so a bare approve still skips. The
hidden fingerprint stamp emission is unchanged (rereview-mode.ts documents
why it stays), and the README's Version attribution section now describes
the footer and the sanitizer constraint that forced it.
