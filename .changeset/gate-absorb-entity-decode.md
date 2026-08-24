---
"review": patch
---

The dispatch gate's rule 7 no longer false-blocks a review whose plan quotes angle brackets. Run 32758584548 (Khan/actions#371) staged a footer quoting `&lt;STOP: ...&gt;` (the renderer escapes angle brackets it quotes), gh-aw's ingest sanitizer decoded the entities and convertXmlTags parenthesised the result on the queued side, and the plan-vs-queue comparison went red on a fully conforming run, withholding the whole review. HTML entity decoding was a documented-not-absorbed residual of `sanitizer-normalize.ts`; it is now absorbed the way the `<skill>` placeholder shape was: `normalizeBody` mirrors the sanitizer's decodeHtmlEntities (named, decimal, hex, one level of `&amp;` double-encoding, gh-aw v0.85.4) on both comparison sides, sequenced before the invisible-character strips exactly as hardenUnicodeText sequences it, so an entity-vs-literal splice that changes text still fails.
