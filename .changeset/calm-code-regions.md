---
"review": patch
---

Use the consumer's pinned gh-aw sanitizer for staged review text instead of maintaining a second implementation of its transforms. Compare the already-sanitized queue without reparsing its code spans, fixing false publication failures when URL redaction changes backtick pairing. Missing or incompatible sanitizer code blocks publication, with no legacy comparison fallback. Keep the existing formatting and same-host URL tolerances, and test against byte-exact upstream fixtures offline.
