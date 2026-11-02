---
"secure-network": minor
---

Make setup faster.

-   Read the GitHub Actions domains only from the bundled `github-meta.json`. Do not call the GitHub meta API. Unauthenticated calls from shared egress IPs got HTTP 403, and the retries took up to 18.5 s. A weekly workflow runs `gen-github-meta.sh` and opens a PR when the domains change.
-   Remove the DNS cache prewarm.
-   Run the final DNS check in parallel (16 lookups at a time).
-   Start the script with `execFileSync` (no shell), so input values cannot inject commands. The shell does not expand `$VAR` in `conf-files` and `extra-domains` now. Use a GitHub expression or an absolute path.
