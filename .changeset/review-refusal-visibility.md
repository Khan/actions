---
"review": minor
---

review: surface why a sub-agent produced nothing, and fall back when it refused

A sub-agent that the provider blocks under its usage policy returns **no final
text**, which the eval reported as `malformed output: output carries no
parseable JSON object`. Nothing malformed was emitted; nothing was emitted at
all. That message cost three eval runs (~$30) chasing a contract bug before the
instrumentation here identified it in one $1.57 run.

Visibility, on both the eval and production paths:

- An empty final is named as such, distinct from unparseable prose, and carries
  the provider's stop reason.
- Both runners keep the failure detail they were discarding: the error message,
  the provider's raw stop reason, and the token counts at failure (which ruled
  out context overflow at 5,207 tokens).
- A failed agent's raw final text is captured (truncated) and rendered in the
  A/B report, so a failure is diagnosable without spending a run per hypothesis.
- Per-agent tool-call counts on both arms, the investigation-depth signal the
  README already tells readers to check.

The fallback: run 30656579898 caught `correctness-reviewer` refusing
`incident-auth-bypass` and `adversarial-injection-approve` outright, under
Anthropic's usage policy for "violative cyber content". The hazard was known and
mitigated on the wrong roles: the README keeps the specialist lenses on Opus
"because Fable's cyber safety classifiers can refuse benign security-focused
analysis, and a refused security lens would be a silent coverage hole", while
`correctness-reviewer` — the default roster's load-bearing recall agent — was
moved onto Fable 5 by the 2026-07-20 A/B and has been there since.

A refusal is deterministic in the model, so retrying the pin cannot help.
`lib/refusal-fallback.ts` maps `claude-fable-5` and `claude-opus-5` to
`claude-opus-4-8`, the incumbent for every security-sensitive role. One hop,
never back to a model that already refused, and no fallback for an unlisted pin
so a new family's refusal profile stays visible rather than papered over. The
swap is recorded per agent (`fellBackTo`), because turning an invisible skip
into an invisible model swap would defeat the purpose.
