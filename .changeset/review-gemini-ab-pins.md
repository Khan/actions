---
"review": minor
---

review: route model pins by provider, and pin the sub-agents to
gemini-3.8-flash for a cross-provider A/B

The Pi runner's multi-provider claim is now exercised for real. Model pins
resolve through a routing layer (`lib/dispatch-models.ts`): `gemini-*` pins
resolve against Pi's Google (Gemini API) catalog, everything else stays on
the Anthropic catalog, and an unknown pin still throws with the candidates
listed rather than silently substituting. The Google provider authenticates
with `GEMINI_API_KEY`, which the eval workflow passes alongside
`ANTHROPIC_API_KEY`.

`gemini-3.8-flash` shipped 2026-09-02 and the pinned pi-ai 0.84.4 catalog
predates it, so the runner registers the provider with one local catalog
entry (launch intro pricing, $0.75/$3.75 per MTok) that a future pi-ai
bump's own entry supersedes by id.

pi-ai and pi-agent-core move from 0.83.0 to 0.84.4 (the latest release,
2026-08-28). 0.83.0 predates gemini 3.7 and gets Gemini 3 function calling
wrong in two ways that the first measured A/B run paid for: it sent every
gemini functionResponse without the `id` Gemini 3 requires to tie a response
to its call (its `requiresToolCallId` covered only claude and gpt-oss
models), and it dropped empty text and thinking blocks even when they
carried the `thoughtSignature` Gemini 3 uses to keep reasoning continuous
across tool-call turns. A model whose tool responses are unlabelled and
whose reasoning chain breaks at every tool call re-reads what it already
read, which is what run 33671015442's candidate arm looked like (1117 tool
calls to claude's 257, one agent at 143 on a two-file case). 0.84.4 fixes
both. The anthropic path was correct throughout, so the claude arms are
unaffected by the bump beyond re-verification.

Every dispatch (and the prose judge) now carries an explicit thinking
level, a blanket `high`, because pi-ai's no-reasoning default was wrong on
both provider families. Anthropic: pi-ai sends `thinking: {type:
"disabled"}`, but the Claude Agent SDK harness this runner replaced
defaulted opus-4.6+ to ADAPTIVE thinking at effort high, so the pi port had
silently turned off the thinking production reviewers run with (the
re-anchoring harness A/B unknowingly compared SDK-adaptive-high against
pi-thinking-disabled). Google: pi-ai translates "no thinking requested" on
a gemini-3-flash model into a hardcoded `thinkingLevel: MINIMAL`, which the
3.7+ API rejects with a 400: the first A/B run's candidate arm died on
exactly that, every dispatch $0 in 2 seconds. The catalog entry's level map
declares `off` and `minimal` unsupported (the 3.8 API takes LOW/MEDIUM/HIGH
only). With both arms at high, the A/B isolates the model swap.

Every sub-agent `model:` pin in review.md moves to `gemini-3.8-flash` so the
live A/B measures that model against main's claude baseline on the same
harness. This is a measurement state, not a production pin decision: the
engine pin, the prose judge, and the eval's judge/arbiter stay on claude,
and production gemini traffic is deliberately not wired (the awf api-proxy
meters Anthropic only, so a production move needs firewall and proxy work
first).

The eval was not isolated from its own answer key, found by reading the
gemini transcripts rather than the tool-call count. The runner VM has this
repo checked out beside the staged cases, srt's read denial covered only
`~/.ssh`, and a reviewer that searches the filesystem (`find / -name
investigation-cap.ts`) finds the corpus with each case's must-catch spec,
the scorer, and the contracts source. gemini-3.8-flash did, on every run;
claude checked once for the lib and stayed in the checkout, which is luck,
not a property of the eval. The tool sandbox now takes caller-supplied
`denyRead` paths: the live A/B denies the repo root (its cases live under
/tmp and need nothing from it), the smoke denies `workflows/` and `.github/`
and links a lib containing only the cap CLI in place of the whole repo, and
transcripts are written under /tmp instead of the repo's `out/` (a reviewer
read a sibling agent's transcript through the old link). The system prompt
gains scope lines saying what claude inferred and gemini did not: the
changed files and what they call are in scope, the review tooling and
anything outside the working directory are not, and the output contract is
emitted as described rather than validated against the tooling's source.

Also fixed on the way: the `ANTHROPIC_BASE_URL` steer used to re-register
the provider through `createProvider({...provider, baseUrl})`, which throws
in pi-ai 0.83.0 and 0.84.4 (createProvider wants the provider's input shape, and the
built provider does not re-expose it). The steer now rewrites each catalog
model's own `baseUrl`, the field the API layer actually reads. The eval VM
runs unsteered, which is why no run tripped it.
