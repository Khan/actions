---
"review": patch
---

review eval: the noise column tells a legitimate unspecced finding from a
template comment, and the matcher credits the spec's own lens

"Unmatched posted" only ever meant the spec did not list it. Reading run
33671015442's postings instead of its noise column, 10 of the claude arm's 22
unmatched findings were code-grounded defects the smoke fixtures really carry
(an empty-string account id fallback, an unvalidated discount rate, a quota
clamp that hides overage, an ADD COLUMN NOT NULL DEFAULT table rewrite, a
bare-string status type, a "retention cap" comment with no cap in the
package, a test fake ordering rows opposite to the store's contract, fakes
that never fail, an unescaped traceID in a query string, and the injection
comment itself), 6 were a "no test covers X" template, and the eval scored
all of them the same.

Three changes, batched because every fixture edit moves the corpus hash:

- Live cases gain `live.mayFlagSpecs`: labeled real defects the fixture
  carries that are not the case's ground truth. A posted finding matching
  one is reported as "legitimate unspecced" and leaves the noise numerator,
  and it earns no recall. Eight of the ten live smoke cases now carry the
  entries the audit produced (12 in all, 11 of which the recorded run
  exercised). clean-no-findings and
  incident-cache-missing-key carry none because the reading found nothing.
  None of the audited defects changes an expected verdict, so no fixture
  moved beyond the false-block case's stub `ListTraces`, which returned an
  undeclared variable and now decodes its request like its siblings.
- Leftover findings are classified rather than lumped: legitimate unspecced
  (above), duplicate of a caught spec (same location and mechanism as a
  defect another finding already claimed, a merge-stage miss that still
  counts as noise), or residual noise. The report gets an "of which
  duplicates" row under noise and a "Legitimate unspecced" row. The
  aggregate reads both shapes of artifact and sums unmatched plus duplicates
  so pooled noise stays comparable with older reports.
- When several posted findings satisfy one spec, the matcher now prefers the
  one whose code-assigned `source` is the spec's `lens` before falling back
  to posted order. On
  the recorded run that moves the credit on four cases from a correctness
  neighbour to the security-auth, money-payments, concurrency-async, and
  data-migrations findings that actually described the defect (the race
  case had credited a TTL suggestion two lines away).

Replayed over the recorded run, the claude arm's noise reads 35% (4 of 11
duplicates) instead of 71%, with 11 legitimate unspecced findings beside it.
The gemini arm reads 18% instead of 27%. Recall is unchanged on both arms.
