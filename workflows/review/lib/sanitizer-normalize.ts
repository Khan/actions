/**
 * The ingest sanitizer's transforms, mirrored so the dispatch gate's rule 7
 * can compare a staged submission plan against the queued safe outputs
 * without false-blocking a byte-faithful transcription.
 *
 * gh-aw v0.81.6 rewrites everything the agent queues before the gate sees it
 * (`sanitize_content_core.cjs`): HTML comments vanish, unicode is hardened,
 * template delimiters gain escaping, and URLs are redacted under an
 * allowed-only policy. The plan is composed BEFORE that pass, so the two
 * sides differ on a conforming run. {@link normalizeBody} applies every
 * absorbed transform to BOTH sides, so tolerance costs no splice detection:
 * anything the sanitizer would not have done is still a mismatch (#244).
 *
 * Documented-not-absorbed residuals, each of which needs a pathological body
 * and fails red rather than silently: HTML entity decoding, XML tag
 * conversion, the percent-decode side effect, homoglyph folds, the 65k
 * truncation, markdown link titles, and tilde fences.
 */

/**
 * Fold one body to its sanitizer-tolerant comparison form. Applied to the
 * plan and the queued text alike; never to text that gets posted.
 */
export const normalizeBody = (text: string): string =>
    text
        // The ingest sanitizer deletes ALL XML/HTML comments
        // (removeXmlComments), so the queued body can never carry the
        // plan's fingerprint stamp; comparing modulo comments is what
        // "sanitizer-tolerant" requires (trial run 29893634730 blocked
        // a byte-faithful transcription on exactly this).
        .replace(/<!--[\s\S]*?-->/g, "")
        // The sanitizer's hardenUnicodeText applies NFKC and strips
        // zero-width characters (gh-aw sanitize_content_core.cjs), which
        // rewrites compatibility characters: trial run 29903306596
        // blocked a jq-verbatim emission because one reviewer-authored
        // ellipsis came back as three dots (NFKC). Apply the same
        // normalization on both sides, plus the typographic quote/dash
        // folds NFKC does not cover.
        .normalize("NFKC")
        .replace(/\u034f/g, "")
        // Zero-width, bidi-control (sanitizer step 4), C0/DEL (its
        // control-strip): all deleted on the queued side only, so
        // delete them on both.
        .replace(/[\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/g, "")
        .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
        .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
        .replace(/[\u2012\u2013\u2014\u2015]/g, "-")
        .toLowerCase()
        .replace(/`/g, "")
        // neutralizeTemplateDelimiters escapes {{ ${ {% {# <%= outside
        // code regions; drop the escaping backslashes on both sides.
        .replace(/\\(?=[{$%#<])/g, "")
        // URL sanitization applies even inside code regions under the
        // deployed allowed-only policy: a non-allowlisted domain or a
        // non-https scheme is rewritten to "(host/redacted)" or
        // "(redacted)" (sanitizeUrlDomains / sanitizeUrlProtocols,
        // gh-aw v0.81.6). Domain redaction KEEPS the host, so an https
        // URL folds to a host-bearing placeholder that both sides
        // agree on and a cross-host link splice still trips the check.
        // Protocol redaction drops the host entirely, so every other
        // scheme folds hostless (matching the bare "(redacted)").
        // Deliberate residual: path and query ARE wildcarded, so swapping
        // one same-host deep link for another passes rule 7; the splice
        // check covers the prose and the link's host, not which page on
        // that host is cited.
        .replace(/https:\/\/([a-z0-9.-]+)\S*/g, "<url:$1>")
        .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/g, "<url>")
        .replace(
            /(?:mailto|javascript|vbscript|data|about|tel|magnet):\S+/g,
            "<url>",
        )
        .replace(/\(([a-z0-9.-]+)\/redacted\)/g, "<url:$1>")
        .replace(/\(redacted\)/g, "<url>")
        .replace(/\s+/g, " ")
        .trim();
