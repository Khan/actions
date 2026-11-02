---
"secure-network": minor
---

secure-network: make setup faster

-   Add a `github-token` input (default: the job's token). The GitHub meta API call sends it, so the call is not rate limited from shared egress IPs.
-   Do not retry the meta API call on HTTP 4xx. Use the bundled `github-meta.json` at once. Retry network errors and 5xx at most 3 times.
-   Run the DNS prewarm and the final DNS check in parallel (16 lookups at a time).
