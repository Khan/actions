---
"review": minor
---

review: add a Pi-backed sub-agent harness behind the existing runner seam

Scripted dispatch gains a second `AgentRunner` implementation
(`lib/dispatch-runner-pi.ts`) built on Pi's libraries (`@earendil-works/pi-ai`
+ `@earendil-works/pi-agent-core`), selected by `REVIEW_DISPATCH_RUNNER=pi`.
The Claude Agent SDK runner stays the default and the production path; no model
pin changes, and `dispatch.ts` still imports neither runner (the CLI entry
loads one lazily).

This is a harness switch, not a model switch. Both runners honor the same
per-role `model:` pins, so a `pi`-vs-`sdk` A/B on an unchanged `review.md`
isolates the loop as the single variable. That comparison is the point: Pi's
libraries are multi-provider, so once the harness is anchored, moving a role
off Anthropic becomes a pin change rather than a second bespoke agent loop, and
both arms of a cross-provider A/B then share one loop instead of comparing two
harnesses and calling the difference a model result.

Pi also reports usage with a per-component `cost` breakdown (input, output,
cacheRead, cacheWrite), so `AgentResult.usd` stops inheriting the api-proxy
default-pricing path's known cache-write under-count.

The runner is contract-identical to the SDK one: same `AgentResult` fields,
same timeout and abort semantics, same salvage of an already-accepted
`submit_result` payload, and the same validate-then-accept structured-final
channel. It supplies its own Read/Grep/Glob/LS/Bash with explicit output caps
rather than inheriting Pi's harness tools, so the reviewers can never be handed
edit or write, and so the truncation behavior a harness A/B is actually reading
stays visible and unit-tested. The eval takes the same switch
(`live-runner.ts`'s `selectedRunner`), pinned to the eval's three-tool surface
so neither arm out-investigates the other, and the A/B workflow exposes it as
the `dispatch_runner` dispatch input.

Unproven by design: the corpus numbers, noise bands, and the drift budget were
all measured on the SDK loop and do not transfer. Re-anchor with a harness A/B
on identical pins before reading any model comparison through Pi. The Pi
dependency is 0.x and pinned exactly.
