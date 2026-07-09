---
"review": minor
---

Fold-in batch: quality disciplines plus measured cost fixes for the shared PR reviewer.

Quality fold-ins:

- **Failure scenario required.** Every finding (not just blocking ones) carries a concrete `failure_scenario` (specific inputs/state, then the wrong outcome). The field is required in the structured finding schema (`FINDING_SCHEMA_VERSION` 2), emitted by every producer, and carried into `claims.json`; the `claim-validator` attacks exactly that scenario.
- **Quote-the-rule discipline.** A skill or conventions violation may only be flagged when the exact rule text and the exact violating line can both be quoted (skill-auditor, conventions, lens-owned skills); the validator never confirms a skill claim that cannot quote its rule.
- **Amplification nuance.** A claim about a mechanism that predates the diff is confirmed only when the diff materially amplifies its consequence, and the finding must say so; producers state introduce-vs-amplify explicitly.
- **Method-angle procedures.** The correctness reviewer works the diff through three named procedures: a line scan, a removed-behavior audit (name the invariant every deleted line enforced and find where the new code re-establishes it), and a cross-file trace of changed symbols' callers/callees.
- **Change-provenance gate, enforced in code.** New `lib/diff.ts` + `lib/provenance.ts` parse the staged diff into a per-file changed-line map (`provenance.json`); a finding whose anchor is not an added/modified diff line cannot carry a blocking label, and pre-existing observations collapse into at most one non-blocking note (`renderPreExistingNote`). Fails open on an unparseable diff. Wired through the no-post runner and covered by unit tests plus a smoke corpus case.

Measured cost fixes:

- **Generated-stripped whole-change diffs.** The provenance CLI also stages `full-stripped.diff` (the full diff minus files the router classifies `linguist-generated`; `routing.json` now exposes `generatedFiles`), and every whole-change reviewer and specialist lens reads it instead of the full diff.
- **Graceful budget exhaustion.** Nearing the AI-credits cap the orchestrator sheds remaining work in a fixed order and submits the verdict from the findings validated so far, with skipped-dimension notes, instead of dying at the cap with nothing posted.
- **Batched safe-output tail.** The orchestrator emits same-kind safe outputs (thread resolutions especially, and inline comments) together in as few calls/turns as possible.
