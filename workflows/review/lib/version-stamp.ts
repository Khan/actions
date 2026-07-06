/**
 * R11/R14: the reviewer **version stamp** — a stable hash of the reviewer's
 * prompt + config, rendered into the *existing* #194 HTML comment marker.
 *
 * This is the SINGLE drift-guard surface (plan §"one version surface"): R14's
 * config-drift guard does NOT add a second mechanism — it reads this stamp. A
 * consumer repo's sync check parses the marker off a posted review comment (or a
 * committed skill snapshot) and compares the `stamp=` value against the one it
 * last synced; a mismatch means the shared reviewer's prompt or config changed
 * since the consumer pinned it. The eval suite uses the same stamp to
 * label a run so a metrics regression can be attributed to a specific reviewer
 * version.
 *
 * Determinism boundary: this module authors no prose about code
 * under review. Every string it emits is a hash, a marker key, or a structural
 * token — never a sentence composed about a diff.
 *
 * Why "prompt + config" and not the whole repo: drift that matters to a consumer
 * is a change to *what the reviewer does* — the sub-agent prompts, the lens
 * roster, the model/effort assignments, the finding schema version, and the
 * tunable thresholds. A change to, say, a test fixture does not change the
 * reviewer's behaviour and must not churn the stamp. Callers therefore pass the
 * behaviour-defining inputs explicitly (see {@link VersionStampInput}); the hash
 * is over exactly those.
 */

import {createHash} from "node:crypto";

import {FINDING_SCHEMA_VERSION} from "./finding-schema";

/**
 * Monotonic version of the *stamp format* itself (the marker syntax + the set of
 * inputs folded into the hash). Bump only when the stamp's wire shape changes in
 * a way a consumer sync check must notice; it is carried in the marker so an old
 * consumer can tell "I don't understand this stamp format" apart from "the
 * reviewer changed".
 */
export const VERSION_STAMP_FORMAT = 1;

/** The marker key — reuses the `pr-reviewer:` namespace #194 established. */
export const VERSION_MARKER_KEY = "pr-reviewer:version";

/**
 * The behaviour-defining inputs folded into the stamp. All optional so a caller
 * can stamp a partial surface (e.g. only the prompts) during a migration, but in
 * production every field is populated from the live workflow:
 *
 *   - `prompts`: name -> prompt text for `review.md` and every inline sub-agent
 *     prompt. A prompt edit (one of the thirteen) changes the stamp.
 *   - `config`: the tunable knobs — model/effort table, lens roster, router
 *     rules, blocking threshold, investigation cap. A config change changes the
 *     stamp.
 *   - `schemaVersion`: defaults to {@link FINDING_SCHEMA_VERSION}; a schema bump
 *     changes the stamp (a consumer must re-sync when the finding shape changes).
 */
export type VersionStampInput = {
    prompts?: Record<string, string>;
    config?: Record<string, unknown>;
    schemaVersion?: number;
};

/**
 * A parsed version marker. `stamp` is the content hash; `format` is
 * {@link VERSION_STAMP_FORMAT} at author time; `schema` is the finding-schema
 * version the reviewer was on. A consumer sync check compares `stamp`.
 */
export type ParsedVersionMarker = {
    stamp: string;
    format: number;
    schema: number;
};

/* -------------------------------------------------------------------------- */
/* Canonicalisation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Deterministically serialise an arbitrary JSON-ish value with object keys
 * sorted at every depth, so two logically-equal configs that differ only in key
 * order (or were built in a different order) hash identically. This is what makes
 * the stamp stable: the hash is a function of the *content*, not the insertion
 * order or whitespace of the input.
 *
 * `undefined` object properties are dropped (they carry no content); `undefined`
 * array elements are preserved as `null` (position is content in an array).
 */
export const canonicalize = (value: unknown): string => {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value ?? null);
    }
    if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalize(v)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
    return `{${entries.join(",")}}`;
};

/* -------------------------------------------------------------------------- */
/* Stamp computation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Compute the reviewer version stamp: a hex SHA-256 over the canonicalised
 * (prompts, config, schemaVersion, format) tuple. Pure and deterministic — no
 * clock, no randomness — so the same inputs always yield the same stamp and a
 * changed input always yields a different one (the guarantee: "stamp
 * changes when prompt/config changes"). Truncated to 16 hex chars: a 64-bit
 * prefix is far more than enough to make an accidental collision between two
 * reviewer versions impossible in practice, while keeping the marker compact.
 */
export const computeVersionStamp = (input: VersionStampInput): string => {
    const payload = {
        format: VERSION_STAMP_FORMAT,
        schemaVersion: input.schemaVersion ?? FINDING_SCHEMA_VERSION,
        prompts: input.prompts ?? {},
        config: input.config ?? {},
    };
    return createHash("sha256")
        .update(canonicalize(payload), "utf8")
        .digest("hex")
        .slice(0, 16);
};

/* -------------------------------------------------------------------------- */
/* Marker render / parse (the consumer-readable surface)                      */
/* -------------------------------------------------------------------------- */

/**
 * Render the version marker line. Reuses the #194 HTML-comment marker convention
 * (`<!-- pr-reviewer:… -->`) so it is invisible in rendered Markdown yet greppable
 * by a consumer sync check. Shape:
 *
 *     <!-- pr-reviewer:version stamp=<hex> format=<n> schema=<n> -->
 *
 * Keys are space-separated `key=value` with no quoting (all values are
 * `[0-9a-f]`), so {@link parseVersionMarker} can recover them with a single regex.
 */
export const renderVersionMarker = (input: VersionStampInput): string => {
    const stamp = computeVersionStamp(input);
    const schema = input.schemaVersion ?? FINDING_SCHEMA_VERSION;
    return `<!-- ${VERSION_MARKER_KEY} stamp=${stamp} format=${VERSION_STAMP_FORMAT} schema=${schema} -->`;
};

const MARKER_RE = new RegExp(
    `<!--\\s*${VERSION_MARKER_KEY}\\s+stamp=([0-9a-f]+)\\s+format=(\\d+)\\s+schema=(\\d+)\\s*-->`,
);

/**
 * Recover the {@link ParsedVersionMarker} from text containing the marker (a
 * posted review body, a committed skill snapshot, …), or `null` when no marker is
 * present. This is the exact operation a consumer sync check runs: parse, then
 * compare `.stamp` against the last-synced value. Returns the first marker found;
 * a body carries at most one.
 */
export const parseVersionMarker = (
    text: string,
): ParsedVersionMarker | null => {
    const match = MARKER_RE.exec(text);
    if (match === null) {
        return null;
    }
    // The three capture groups are guaranteed present by a successful match.
    const [, stamp, format, schema] = match as unknown as [
        string,
        string,
        string,
        string,
    ];
    return {
        stamp,
        format: Number.parseInt(format, 10),
        schema: Number.parseInt(schema, 10),
    };
};

/**
 * Whether two stamps differ — the one-line predicate a consumer drift guard
 * calls. Kept as a named function (rather than `!==` at the call site) so the
 * "drift" concept has a single, documented home and R14's guard reads as intent.
 */
export const hasDrifted = (
    syncedStamp: string,
    currentStamp: string,
): boolean => syncedStamp !== currentStamp;
