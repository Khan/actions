---
"review": patch
---

Fix the conventions reviewer's stale self-description: it claimed to be router-gated behind a convention-trigger signature, but no such gate exists in the router; an `enable conventions` line dispatches it on every review. The prose now says opt-in, drops the false premise that a convention-bearing area was necessarily touched, and tells the reviewer to return empty findings rather than reach when the diff engages no convention. Surfaced by the reviewer itself on Khan/webapp#40678.
