---
"review": major
---

Model traffic now goes through ai-router's Anthropic route (OpenRouter, pinned to Anthropic) instead of straight to Anthropic, and so do the live evals unless `ANTHROPIC_BASE_URL` says otherwise. **Before bumping, swap your repo's `ANTHROPIC_API_KEY` secret for an ai-router token**, or every model call returns `403 Forbidden`. In Khan/actions the same secret also feeds the eval workflows (`review-eval-*.yml`, `review-rereview-sweep.yml`). See "Model traffic goes through ai-router" in the review README.
