---
"review": minor
---

Move the reviewer roster to Opus 5 (`claude-opus-5`). `pattern-triage` stays on Sonnet 4.6 as the cheap first pass.

The specialist lenses were kept off Fable 5 because cyber safety classifiers can refuse benign security-focused analysis, and a refused lens is a silent coverage hole: it surfaces as a missing agent result, not an error. Opus 5 can also return `stop_reason: "refusal"` on cyber-adjacent input, so this move re-opens that hole rather than closing it. The detector is the weekly drift corpus, where a refusing lens craters must-catch recall on security-adjacent cases while every other metric looks normal. On that signature, put the `security-auth` lens back on `claude-opus-4-8` first.
