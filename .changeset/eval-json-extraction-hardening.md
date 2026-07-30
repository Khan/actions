---
"review": patch
---

review: eval-harness JSON extraction survives prose braces and invalid string escapes

Every live seam (finder and validator output in the producer, judge scoring, the match arbiter) sliced model output with `/\{[\s\S]*\}/` (first `{` through last `}`) plus a strict `JSON.parse`. Two recurring live failures follow from that rule: an agent that quotes a template literal from the diff (`` `user-profile:${tenantId}` ``) before its JSON payload fails with "Expected property name or '}'" (the standing incident-cache-missing-key agent failures; the retry re-quotes the same snippet, so it never recovers), and one invalid string escape from the judge (`\'`) kills a whole arm's scoring ("Bad escaped character in JSON"). The new shared `extractJsonObject` walks balanced brace candidates left to right, retries a failed slice with invalid string escapes repaired, and returns the last top-level object that parses. The match arbiter also stops silently reporting "no match" when its yes verdict rides alongside prose braces.
