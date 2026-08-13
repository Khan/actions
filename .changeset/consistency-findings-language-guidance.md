---
"review": patch
---

review: consistency findings must survive language guidance

A "match the existing pattern" claim now has to check the pattern itself: the
claim-validator refutes a consistency claim when the pattern the fix would
restore contradicts the language's or standard library's documented guidance
(the measured case: a reviewer proposed moving a new method's ctx parameter
onto the struct because sibling methods stored one, against the Go context
package's explicit rule). Consistency alone never outranks documented language
guidance; inverting the claim to flag the pattern instead needs the ordinary
evidence bar, and the pre-existing-mechanism cap applies. The
correctness-reviewer carries one mirroring sentence so fewer such claims are
generated, and a deterministic clean corpus case
(clean-consistency-ctx-param) pins the drop.
