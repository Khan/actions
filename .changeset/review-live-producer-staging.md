---
"review": minor
---

Live eval arm, phases 2a and 2b (live A/B plan): sub-agent prompt extraction and case staging. `eval/agent-extract.ts` parses `review.md`'s `## agent:` sections into name/description/model/prompt as pure data (string in, no fs), so an A/B can extract the baseline arm from a `git show` of the merge-base; parsing is strict and lists every malformed section at once, and an integration test runs it over the real `review.md`. `eval/live-stage.ts` materializes the production `/tmp/gh-aw/review/` staging layout for a live-enabled corpus case (pr-context.json, full/pr/full-stripped diffs, files.json with hasPatch, review-files.json, provenance.json, routing.json, out/, and the post-change checkout) and rewrites extracted prompts to point at it, behind an injected-fs seam. No model dispatch yet; that is phase 2c.
