---
"review": minor
---

Move the entire reviewer roster to Opus 5 (`claude-opus-5`): every role that ran `claude-opus-4-8` (orchestrator, `thread-reconciler`, `skill-auditor`, `claim-validator`, `conventions`, `documentation`, the opt-in `holistic` / `completeness` / `test-adequacy`, and all twelve specialist lenses) and both that ran `claude-fable-5` (`correctness-reviewer`, `first-principles`). `pattern-triage` stays on Sonnet 4.6 as the deliberately cheap first pass; the eval's judge and match arbiter stay on Haiku 4.5, being the ruler rather than the reviewer.

Opus 5 reports high precision and high recall at Opus 4.8's per-token price, half Fable's: a straight upgrade for the roles on 4.8, and for the two on Fable it should keep the recall the 2026-07-20 A/B bought (82% -> 89% must-catch) without the +35% premium. The powered A/B is the acceptance criterion, not this description. Read four rows first, each independently revertable: `correctness-reviewer` (recall), `claim-validator` (precision), the `security-auth` lens, and the orchestrator (throughput under the wall clock).

**Known risk: refusal on the specialist lenses.** Those were kept off Fable because cyber safety classifiers can refuse benign security analysis, and a refused lens is a silent coverage hole rather than an error. Opus 5 can also return `stop_reason: "refusal"` on cyber-adjacent input, so this re-opens that hole. The detector is the weekly drift corpus; on that signature put `security-auth` back on `claude-opus-4-8` first, the narrowest revert available.

`claude-opus-5` is priced by the `models.providers` overlay this stacks on, so it needs firewall v0.27.43 (gh-aw v0.84.x). Under v0.27.42 the overlay is dropped, the model is un-priced, and the api-proxy rejects every dispatch with a 400: do not merge before that release is stable.

Also bumps `@anthropic-ai/claude-agent-sdk` to `^0.3.219`, the first release that knows `claude-opus-5`. The eval enforces `--max-usd` from the SDK's reported `total_cost_usd`, so an older SDK turns the budget cap into a no-op on precisely the arm under test. Eval-only; the SDK is not in the api-proxy path.
