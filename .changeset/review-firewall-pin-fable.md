---
"review": patch
---

Actually unblock the first-principles reviewer: the review-v1.2.1 `models:` pricing block only feeds gh-aw's cost-summary display and never reaches the firewall api-proxy's AI-credits guard, which kept rejecting claude-fable-5 with a 400. The frontmatter now pins `sandbox.agent.version` to gh-aw-firewall v0.27.27, the release whose api-proxy bundles curated Claude 5 pricing; the `models:` block stays so cost accounting shows the same numbers. Both are marked for removal once gh-aw's default firewall is v0.27.27 or newer. The lib-checkout ref is bumped to the release this ships in.
