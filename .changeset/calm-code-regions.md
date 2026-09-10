---
"review": patch
---

Use the consumer's pinned gh-aw sanitizer for staged review text instead of maintaining a second implementation of its transforms. Compare the already-sanitized queue without reparsing its code spans, fixing false publication failures when URL redaction changes backtick pairing. Pre-agent staging checks the host sanitizer before paid dispatch, and missing or incompatible sanitizer code still blocks publication, with no legacy comparison fallback. Failures report bounded cause categories without exposing exception details or review text. Keep the existing formatting and same-host URL tolerances, and test against byte-exact upstream fixtures offline.
