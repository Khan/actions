---
"review": patch
---

review: absorb the sanitizer's XML tag conversion in rule 7, which false-blocked a conforming run

The dispatch gate's rule 7 compares the staged submission plan against the
queued safe outputs under `normalizeBody`, which mirrors every ingest-sanitizer
transform it has chosen to absorb. XML tag conversion was on the
documented-not-absorbed list, justified as needing "a pathological body". It
does not: a reviewer writing a path template like
`plugins/<p>/skills/<skill>/SKILL.md` in prose is the most natural way to name
a placeholder, and gh-aw's `convertXmlTags` (sanitize_content_core.cjs)
rewrites the unknown `<skill>` to `(skill)` while preserving the allowed
`<p>`. The plan is staged before that pass, so the two sides differed by one
token on a fully conforming run, rule 7 reported `submission-plan-mismatch`,
and the whole REQUEST_CHANGES review was withheld
(Khan/kore-marketplace run 31609578203; the misleading `(4) do not match (4)`
detail is the count printing on a content mismatch).

`normalizeBody` now applies a `foldXmlTags` mirror of the sanitizer's
transform to BOTH sides: same tag regex, same https angle-bracket autolink
preservation, same allowed-tag list, same parenthesis rewrite. Splice
detection is preserved where it can be: a queued `(p)` against a staged `<p>`
(an allowed tag the sanitizer would have kept) still mismatches. The fold runs
before the URL folds so it never touches their `<url:host>` placeholders.
Remaining sub-residuals, still documented and still requiring a genuinely
pathological body: dangerous-attribute stripping inside a preserved allowed
tag, and CDATA marker rewriting.

Verified against the incident artifacts: the staged `comment-2.json` and the
sanitized queued item from `agent_output.pre-gate.json` now fold equal.
