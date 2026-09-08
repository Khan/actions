---
"review": patch
---

Tightens the opt-in maintainability reviewer's usefulness threshold. Findings must name a concrete maintenance task and show how the proposed fix reduces work without changing behavior or removing a useful boundary. Naming findings must account for the signature, nearby contract, and caller. One caller is a search clue rather than evidence against an abstraction, and divergent copies require a quoted shared contract before investigation. The claim-validator checks the same reader-cost requirements.

Adds three synthetic clean controls for a harmless duplicate adapter, a documented retry callback, and a useful one-caller transaction wrapper. Recorded positive examples now state their maintenance task and the benefit of the fix. Deterministic tests establish fixture behavior and scoring, not model precision or recall. Historical candidate sources are documented but aren't scored positives yet.

Expected output effect: fewer low-value advisory comments when maintainability is enabled, with no label, schema, or budget changes. The reviewer remains disabled by default, and no paid live comparison has been run for this change.
