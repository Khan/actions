---
"review": patch
---

When the dispatch gate blocks a run because the queued inline comments don't match the staged submission plan, its report now names the first entry that differs: the path and line, plus a short snippet of each side around the first differing character. Before, it gave only the two counts, which can be equal ("(3) do not match ... (3)"). That made a sanitizer-fold gap look the same as a splice. Adds regression tests for the Khan/mobile#4164 shape, where a `"See all <domain>"` placeholder was rewritten to `(domain)` at ingest. `review-v1.14.0` and later already fold that rewrite on both sides.
