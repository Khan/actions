---
"review": patch
---

review eval: the false-block-consistency-guidance fixture no longer promises
pagination its code does not do

The clean case's new method carried a doc comment ("following the cursor
until the API reports no next page") and a PR title ("with cursor following")
describing a paginated fetch, while the code does one GET and returns. That
is a real doc/code defect written into a fixture whose expected verdict is
APPROVE with nothing posted, so a reviewer that reads the code correctly
fails the case and one that does not passes it. Live run 33671015442's
claude arm blocked on exactly this finding. The comment and PR context now
describe the single fetch the code performs; the ctx-param consistency trap
the case exists for is untouched, and the diff keeps its line count so the
recorded finding's anchor (client.go:23) and the deterministic sibling's
replay are unchanged. The corpus hash moves, so reports before and after
this change are not the same corpus.
