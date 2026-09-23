---
"review": minor
"autofix": patch
---

Move the reviewer roster and the orchestrator from Opus 5 (`claude-opus-5`) to Opus 5.5 (`claude-opus-5-5`): the engine and all 21 Opus sub-agent pins. `pattern-triage` and the clusterer stay on Sonnet 4.6, the prose judge and the refusal-fallback target stay on `claude-opus-4-8`, and `claude-opus-5` stays priced as an `engine:` override candidate.

Two version floors come with the pin, because the API rejects `claude-opus-5-5` from any Claude Code CLI older than 2.1.280 (`400 ... does not support this model; version 2.1.280 or newer is required`, before any work happens). The orchestrator gets `engine.version: "2.1.280"`, since gh-aw v0.85.4 installs 2.1.222 (Khan/agent-settings run 35762500247). Scripted dispatch's sub-agents get `@anthropic-ai/claude-agent-sdk` 0.3.205 -> 0.3.280, since the SDK bundles its own CLI (0.3.205 carries 2.1.205). Khan/agent-settings#148 pinned the engine alone, and on its next run (35763427273) the orchestrator ran on 5.5 while most sub-agents, both core passes included, came back empty, with eight streaming `/v1/messages` 400s in the api-proxy log (the pattern the bundled-CLI floor predicts), so the review held for a human. Remove the engine pin once a gh-aw release defaults at or above the floor.

Pricing follows the pin, and Opus 5.5 lists below Opus 5 ($4 / $20 per MTok, cache reads $0.20, which is 0.05x input rather than the usual 0.1x):

-   `models.providers.anthropic` gains a `claude-opus-5-5` entry at Khan's 50% rate (`2e-06` / `1e-05` / cache read `1e-07` / cache write `2.5e-06`).
-   `default-ai-credits-pricing` drops from 5.0 / 25.0 to 4.0 / 20.0. No released firewall's curated table prices Opus 5.5 (v0.27.44 stops at Opus 5), so this fallback is the api-proxy credit guard's backstop wherever the overlay is dropped.
-   `lib/pricing.ts` gains the Opus 5.5 list rates, so the cost report and the eval A/B tables price it correctly at list.

`lib/refusal-fallback.ts` maps `claude-opus-5-5` to `claude-opus-4-8`. Without this entry the roster pin would have no fallback, and a refusal would stand. Opus 5.5 adds `bio` and `reasoning_extraction` classifiers beside `cyber`, so the pre-emptive case for the entry is stronger than it was for Opus 5.

Effort: Opus 5.5 defaults to `medium`, one level below Opus 5's `high`. Scripted dispatch is unaffected, because `lib/dispatch-runner.ts` and `lib/judge-prose-runner.ts` already pin `effort: "high"`. The orchestrator (and every sub-agent under `dispatch agent`) has no effort field in gh-aw and so drops to medium. The README roster table and the engine comment record this.

autofix: comment-only. The Opus 4.8 hold comment now names `claude-opus-5-5` as the roster target, and notes the CLI floor and pricing a move to it would need. The pinned model is unchanged.
