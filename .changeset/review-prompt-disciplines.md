---
"review": minor
---

Reviewer prompt disciplines plus measured cost fixes.

- **Quote-the-rule discipline.** A skill or conventions violation may only be flagged when the exact rule text and the exact violating line can both be quoted (skill-auditor, conventions reviewer, and every lens-owned skill application); the validator never confirms a skill claim that cannot quote its rule. No spirit-of-the-doc inference.
- **Amplification nuance.** A claim about a mechanism that predates the diff confirms only when the diff materially amplifies its consequence, and the finding must say so explicitly; the correctness reviewer states introduce-vs-amplify on every pre-existing-bug finding.
- **Method-angle procedures.** The correctness reviewer works the diff through three named procedures instead of one flat checklist: a line scan, a removed-behavior audit (name the invariant every deleted line enforced; find where the new code re-establishes it), and a cross-file trace of changed symbols' callers and callees.
- **Graceful budget exhaustion.** Nearing the run's hard ceilings (per-run AI-credits cap, job timeout), tracked via observable proxies since the agent cannot see its own credit spend (elapsed wall-clock, dispatch counts, the investigation journal), the orchestrator sheds remaining work in a fixed order (opt-in reviewers/lenses first, then the risks/patterns comment, then validation) and submits the verdict from findings validated so far plus skipped-dimension notes, instead of dying at a ceiling with everything spent and nothing posted.
- **Batched safe-output tail.** The orchestrator emits same-kind safe outputs together in as few calls and turns as possible; thread resolutions especially, which previously went out one turn apiece.
