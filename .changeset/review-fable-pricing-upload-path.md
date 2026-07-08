---
"review": patch
---

Fix two failures observed on the first production run of review-v1.2.0. The first-principles reviewer failed on every dispatch: its pinned model (claude-fable-5) is not in the AI-credits pricing table bundled with gh-aw <= v0.81.x, so the cost-guardrail API proxy rejected the request with a 400 before it reached the model. The shared frontmatter now merges the model's pricing in via the `models:` field (values matching the curated entry upstream added in gh-aw-firewall v0.27.27), to be removed once gh-aw bundles Claude 5 pricing. Second, the Step 9 artifact-upload instruction now requires the absolute path `/tmp/gh-aw/review/out/`; an orchestrator that passed a relative `out` failed safe-output validation ("no files matched") even though the files existed. The lib-checkout ref is bumped to the release this ships in.
