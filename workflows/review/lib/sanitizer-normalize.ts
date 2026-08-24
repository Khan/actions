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
 * and fails red rather than silently: the
 * percent-decode side effect, homoglyph folds, the 65k truncation, markdown
 * link titles, and tilde fences. HTML entity decoding graduated out of this
 * list the same way the `<skill>` placeholder did: run 32758584548 staged a
 * footer quoting `&lt;STOP: ...&gt;` (the renderer escapes angle brackets it
 * quotes), the sanitizer decoded it and convertXmlTags parenthesised the
 * result, and rule 7 blocked a fully conforming review. Absorbed by
 * {@link decodeHtmlEntities} below. XML tag conversion is absorbed by
 * {@link foldXmlTags} below; its remaining sub-residuals (dangerous-attribute
 * stripping inside a preserved allowed tag, CDATA marker rewriting) still
 * need a pathological body.
 *
 * Transform order mirrors sanitizeContentCore (v0.83.4): unicode hardening,
 * control strip, comment removal, tag conversion, URL protocols, URL
 * domains (autolink pass, https pass, protocol-relative pass). Run 31616001094
 * false-blocked on three URL-fold divergences from that order and shape:
 * an angle-bracket autolink's brackets are consumed by the sanitizer as a
 * unit, a protocol-relative `//host` is redacted (surfaced by a zero-width
 * strip creating `//g` from `/\u034f/g`), and the https path match stops at
 * commas. All three are absorbed below.
 */

/**
 * The HTML tags gh-aw's convertXmlTags preserves (sanitize_content_core.cjs,
 * v0.83.4): GFM-safe tags plus its inline additions. Every other `<tag>` is
 * rewritten to `(tag)` on the queued side, so the same fold has to apply to
 * both sides of the rule-7 comparison.
 */
const SANITIZER_ALLOWED_TAGS = new Set([
    "abbr",
    "b",
    "blockquote",
    "br",
    "code",
    "del",
    "details",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "ins",
    "kbd",
    "li",
    "mark",
    "ol",
    "p",
    "pre",
    "s",
    "span",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
]);

/**
 * Mirror the sanitizer's convertXmlTags on both comparison sides. The
 * transform is NOT a pathological-body case: a reviewer writing a path
 * template like `plugins/<p>/skills/<skill>/SKILL.md` in prose is the most
 * natural way to name a placeholder, and the sanitizer rewrites `<skill>` to
 * `(skill)` (unknown tag) while preserving `<p>` (allowed tag), so a fully
 * conforming run false-blocked on exactly this
 * (kore-marketplace run 31609578203: staged `<skill>`, queued `(skill)`,
 * rule 7 red, review withheld).
 *
 * Same shape as the sanitizer (regex, https-autolink preservation, allowed
 * list, paren rewrite), applied to plan and queued text alike, so a
 * cross-form splice is still caught: a queued `(p)` where the plan staged the
 * preserved `<p>` stays a mismatch. Differences from the original are the
 * absorbed tolerances: no code-region awareness (backticks are still present
 * when this fold runs; the real sanitizer skips code spans, so the symmetric
 * fold knowingly absorbs a tag-vs-paren splice inside a code region that the
 * sanitizer would never produce) and no dangerous-attribute stripping inside
 * preserved tags (still a documented residual). The queued side is
 * idempotent under the fold: parenthesised text contains no angle brackets
 * to match.
 */
const foldXmlTags = (text: string): string =>
    text.replace(/<(\/?[A-Za-z!][^>]*?)>/g, (match, tagContent: string) => {
        // The sanitizer preserves https angle-bracket autolinks
        // (isHttpsAngleBracketAutolink) so its URL filter can inspect them;
        // preserve them here so the URL folds below see the same shape on
        // both sides.
        if (
            /^https:\/\/[\w.-]+(?::\d+)?(\/[^\s<>|]*)?(?:\|[^<>]*)?$/.test(
                tagContent,
            )
        ) {
            return match;
        }
        const tagName = /^\/?\s*([A-Za-z][A-Za-z0-9]*)/
            .exec(tagContent)?.[1]
            ?.toLowerCase();
        if (tagName !== undefined && SANITIZER_ALLOWED_TAGS.has(tagName)) {
            return match;
        }
        return `(${tagContent})`;
    });

/**
 * Mirror sanitizeDomainName: each dot-separated part keeps only its
 * alphanumerics, empty parts vanish, and a joined name longer than 48
 * characters is elided to its first and last 24. The sanitizer applies this
 * to every redacted host, so the plan-side fold has to produce the same name
 * (a dashed host like `my-host.com` redacts to `myhost.com`).
 */
const foldDomainName = (host: string): string => {
    const joined = host
        .split(".")
        .map((part) => part.replace(/[^a-z0-9]/g, ""))
        .filter((part) => part.length > 0)
        .join(".");
    return joined.length > 48
        ? `${joined.slice(0, 24)}...${joined.slice(-24)}`
        : joined;
};

/**
 * Mirror the sanitizer's decodeHtmlEntities (sanitize_content_core.cjs,
 * gh-aw v0.85.4, hardenUnicodeText step 2): named entities for @ and the
 * angle-bracket/ampersand trio, the invisible-character names, then decimal
 * and hex forms, each tolerating one `&amp;`-double-encoding. Decoding runs
 * BEFORE the invisible strips so an entity-spelled zero-width character
 * (`&shy;`, `&zwnj;`) decodes to the code point the next fold deletes,
 * exactly as the sanitizer sequences it. Applied to both comparison sides:
 * the plan is composed pre-sanitizer (a renderer that quotes `<STOP: ...>`
 * escapes it to `&lt;STOP: ...&gt;`), the queued side arrives decoded.
 */
const decodeHtmlEntities = (text: string): string =>
    text
        .replace(/&(?:amp;)?commat;/gi, "@")
        .replace(/&(?:amp;)?gt;/gi, ">")
        .replace(/&(?:amp;)?lt;/gi, "<")
        .replace(/&(?:amp;)?amp;/gi, "&")
        .replace(/&(?:amp;)?shy;/gi, "\u00ad")
        .replace(/&(?:amp;)?zwnj;/gi, "\u200c")
        .replace(/&(?:amp;)?zwj;/gi, "\u200d")
        .replace(/&(?:amp;)?lrm;/gi, "\u200e")
        .replace(/&(?:amp;)?rlm;/gi, "\u200f")
        .replace(/&(?:amp;)?ZeroWidthSpace;/gi, "\u200b")
        .replace(/&(?:amp;)?NoBreak;/gi, "\u2060")
        .replace(/&(?:amp;)?(?:af|ApplyFunction);/gi, "\u2061")
        .replace(/&(?:amp;)?(?:it|InvisibleTimes);/gi, "\u2062")
        .replace(/&(?:amp;)?(?:ic|InvisibleComma);/gi, "\u2063")
        .replace(/&(?:amp;)?(?:ip|InvisiblePlus);/gi, "\u2064")
        .replace(/&(?:amp;)?#(\d+);/g, (match, code: string) => {
            const codePoint = parseInt(code, 10);
            return codePoint >= 0 && codePoint <= 0x10ffff
                ? String.fromCodePoint(codePoint)
                : match;
        })
        .replace(/&(?:amp;)?#[xX]([0-9a-fA-F]+);/g, (match, code: string) => {
            const codePoint = parseInt(code, 16);
            return codePoint >= 0 && codePoint <= 0x10ffff
                ? String.fromCodePoint(codePoint)
                : match;
        });

/**
 * Fold one body to its sanitizer-tolerant comparison form. Applied to the
 * plan and the queued text alike; never to text that gets posted.
 */
export const normalizeBody = (text: string): string =>
    // The sanitizer's hardenUnicodeText applies NFKC and strips
    // zero-width characters (gh-aw sanitize_content_core.cjs), which
    // rewrites compatibility characters: trial run 29903306596
    // blocked a jq-verbatim emission because one reviewer-authored
    // ellipsis came back as three dots (NFKC). Apply the same
    // normalization on both sides, and in the sanitizer's position:
    // BEFORE the comment and tag transforms, which only ever see
    // hardened text on the queued side (run 31616001094: a stripped
    // U+034F turned `/\u034f/g` into `//g` before URL redaction saw it).
    foldXmlTags(
        decodeHtmlEntities(text.normalize("NFKC"))
            .replace(/\u034f/g, "")
            // Zero-width, bidi-control (sanitizer step 4), C0/DEL (its
            // control-strip): all deleted on the queued side only, so
            // delete them on both.
            .replace(/[\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/g, "")
            .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
            // eslint-disable-next-line no-control-regex
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
            // The ingest sanitizer deletes ALL XML/HTML comments
            // (removeXmlComments), so the queued body can never carry the
            // plan's fingerprint stamp; comparing modulo comments is what
            // "sanitizer-tolerant" requires (trial run 29893634730 blocked
            // a byte-faithful transcription on exactly this). Then the
            // sanitizer's convertXmlTags rewrite, applied to both sides
            // (see foldXmlTags). It runs before the URL folds below, which
            // introduce their own `<url:host>` placeholders that its regex
            // must never touch.
            .replace(/<!--[\s\S]*?-->/g, ""),
    )
        // Typographic quote/dash folds NFKC does not cover.
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
        // "(redacted)" (sanitizeUrlProtocols then sanitizeUrlDomains,
        // gh-aw v0.83.4). Redaction keeps the sanitized host, so a URL
        // folds to a host-bearing placeholder that both sides agree on
        // and a cross-host link splice still trips the check.
        // Deliberate residual: path and query ARE wildcarded, so swapping
        // one same-host deep link for another passes rule 7; the splice
        // check covers the prose and the link's host, not which page on
        // that host is cited.
        //
        // Each fold mirrors its sanitizer counterpart's match shape, in
        // the sanitizer's order, because on a redacted (non-allowlisted)
        // URL the queued side has already consumed exactly that shape:
        // 1. non-https scheme URLs (sanitizeUrlProtocols: eats to
        //    whitespace, keeps the host when one exists);
        .replace(
            /(?<![a-z0-9])(?!https:\/\/)[a-z][a-z0-9+.-]*:\/\/([a-z0-9_.-]*)[^\s]*/g,
            (_match, host: string) =>
                host ? `<url:${foldDomainName(host)}>` : "<url>",
        )
        // 2. single-colon blocklist schemes (always hostless);
        .replace(
            /(?:mailto|javascript|vbscript|data|about|tel|magnet):\S+/g,
            "<url>",
        )
        // 3. https angle-bracket autolinks as a unit: the sanitizer's
        //    autolink pass consumes the surrounding brackets (and keeps a
        //    `|label`), so the plan-side fold must too, or a redacted
        //    autolink leaves an orphaned `<` only on the plan side
        //    (run 31616001094 blocked on exactly this);
        .replace(
            /<https:\/\/([a-z0-9_.-]+)(?::\d+)?(?:\/[^\s<>|]*)?(?:\|([^<>]*))?>/g,
            (_match, host: string, label: string | undefined) =>
                label === undefined
                    ? `<url:${foldDomainName(host)}>`
                    : `<url:${foldDomainName(host)}>|${label}`,
        )
        // 4. explicit https URLs (path stops at whitespace, comma, or the
        //    next https URL, exactly like httpsUrlRegex);
        .replace(
            /https:\/\/([a-z0-9_.-]+)(?::\d+)?(?:\/(?:(?!https:\/\/)[^\s,])*)?/g,
            (_match, host: string) => `<url:${foldDomainName(host)}>`,
        )
        // 5. protocol-relative //host URLs after a delimiter, which the
        //    sanitizer redacts like https (a zero-width strip can create
        //    one out of `/\u034f/g`, per the incident above);
        .replace(
            /(^|[\s([{"'])\/\/([a-z0-9_.-]+)(?::\d+)?(?:\/(?:(?!\/\/)[^\s,])*)?/g,
            (_match, prefix: string, host: string) =>
                `${prefix}<url:${foldDomainName(host)}>`,
        )
        // 6. the queued side's already-redacted forms, to the same
        //    placeholders the plan-side folds above produce.
        .replace(/\(([a-z0-9.-]+)\/redacted\)/g, "<url:$1>")
        .replace(/\(redacted\)/g, "<url>")
        .replace(/\s+/g, " ")
        .trim();
