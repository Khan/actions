---
"secure-network": minor
---

Make setup faster.

-   Add a `github-token` input (default: the job's token). The GitHub meta API call sends it, so the call is not rate limited from shared egress IPs.
-   Do not retry the meta API call on HTTP 4xx. Use the bundled `github-meta.json` at once. Make a maximum of 3 attempts on network errors and 5xx, with a 5 s timeout for each attempt.
-   Run the DNS prewarm and the final DNS check in parallel (16 lookups at a time).
-   Start the script with `execFileSync` (no shell), so input values cannot inject commands.
