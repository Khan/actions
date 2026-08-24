/**
 * A minimal structural reader for gh-aw markdown frontmatter: indentation,
 * `key:` and `- item`, nothing else.
 *
 * Deliberately not a YAML parser. `lib/` carries no YAML dependency (the
 * counters scripts consumers run install nothing; the lib's two runtime
 * deps serve the reviewer's own dispatch path), and every question
 * asked of frontmatter here (is this key present, what scalar does it hold,
 * what list items sit under it) is answerable from the shape of gh-aw
 * frontmatter, which is plain block-style mappings.
 *
 * One behaviour is load-bearing rather than incidental: comment lines are
 * dropped, so a commented-out block reads as **absent**. That is exactly the
 * intended meaning, because commenting a block out is how a consumer disables
 * one (the `observability:` local edit the reviewer's README prescribes for a
 * repo without the `GH_AW_OTEL_SENTRY_*` secrets).
 *
 * Values are normalised on the way out — inline comments stripped, surrounding
 * quotes removed, flow-style lists (`[a, b]`) read as lists — because the
 * checker's contract is "errors must be zero", which makes a FALSE error its
 * worst failure mode. Every one of those spellings is valid YAML that a consumer
 * can legitimately write (and the shipped `review.md` itself uses flow style for
 * `toolsets: [pull_requests, repos]`), so treating any of them as absent would
 * fail a working install. What is still not supported: multi-line flow
 * sequences, anchors/aliases, and block scalars (`|`, `>`).
 */

/** One frontmatter line, reduced to what the callers ask about. */
export type YamlLine = {
    indent: number;
    key?: string;
    value?: string;
    item?: string;
};

/**
 * The frontmatter block of a markdown file: the lines between the leading `---`
 * and the next `---`. Undefined when the file has no frontmatter at all.
 */
export const frontmatterBlock = (content: string): string | undefined => {
    const lines = content.split(/\r?\n/);
    if (lines[0]?.trim() !== "---") {
        return undefined;
    }
    const end = lines.findIndex(
        (line, index) => index > 0 && line.trim() === "---",
    );
    return end === -1 ? undefined : lines.slice(1, end).join("\n");
};

/**
 * Drop a YAML inline comment from a value or list item. A `#` opens a comment
 * only at the start of the value or after whitespace, and never inside a quoted
 * scalar — so `1000 # LOCAL OVERRIDE` loses the comment while `"a # b"` and
 * `https://x/y#frag` keep every character.
 *
 * Not cosmetic: the onboarding skill tells authors to label each local edit with
 * a comment, so without this `Number("2500 # LOCAL OVERRIDE")` is `NaN` and the
 * credit-ceiling check silently never fires, a commented `source:` reports a
 * spurious ref mismatch, and a commented `imports` item reads as a missing
 * import — a false error on a valid install.
 */
export const stripInlineComment = (raw: string): string => {
    let quote: string | undefined;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (quote !== undefined) {
            if (ch === quote) {
                quote = undefined;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === "#" && (i === 0 || /\s/.test(raw[i - 1]))) {
            return raw.slice(0, i).trimEnd();
        }
    }
    return raw.trimEnd();
};

/** Strip one layer of matching surrounding quotes. */
export const unquote = (raw: string): string => {
    const trimmed = raw.trim();
    const first = trimmed[0];
    return (first === '"' || first === "'") &&
        trimmed.length > 1 &&
        trimmed.endsWith(first)
        ? trimmed.slice(1, -1)
        : trimmed;
};

/** Reduce a block to {@link YamlLine}s, dropping blanks and comments. */
export const yamlLines = (block: string): YamlLine[] =>
    block
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
        .map((line) => {
            const indent = line.length - line.trimStart().length;
            const trimmed = line.trim();
            if (trimmed.startsWith("- ")) {
                return {
                    indent,
                    item: stripInlineComment(trimmed.slice(2)).trim(),
                };
            }
            const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(trimmed);
            return match
                ? {
                      indent,
                      key: match[1],
                      value: stripInlineComment(match[2]).trim(),
                  }
                : {indent};
        });

/** The base (outermost) indent of a block's own keys. */
const baseIndent = (lines: readonly YamlLine[]): number =>
    Math.min(...lines.map((line) => line.indent));

/**
 * The lines nested under `key` at this block's own indent level. A `- item`
 * line at the SAME indent as the key, directly after it, also belongs to the
 * key: YAML allows a block sequence at the parent key's indentation, so
 * `imports:` followed by an unindented `- …` is a valid spelling of a working
 * install, and reading it as absent would raise a false error (this checker's
 * worst failure mode). A same-indent `key:` line still ends the block.
 */
export const nested = (
    lines: readonly YamlLine[],
    key: string,
): YamlLine[] | undefined => {
    if (lines.length === 0) {
        return undefined;
    }
    const base = baseIndent(lines);
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].indent === base && lines[i].key === key) {
            const out: YamlLine[] = [];
            for (let j = i + 1; j < lines.length; j++) {
                const line = lines[j];
                const sameIndentItem =
                    line.indent === base && line.item !== undefined;
                if (line.indent <= base && !sameIndentItem) {
                    break;
                }
                out.push(line);
            }
            return out;
        }
    }
    return undefined;
};

/** Walk a key path, returning the deepest block (undefined if any hop misses). */
export const nestedPath = (
    lines: readonly YamlLine[],
    path: readonly string[],
): YamlLine[] | undefined => {
    let current: YamlLine[] | undefined = [...lines];
    for (const key of path) {
        if (current === undefined) {
            return undefined;
        }
        current = nested(current, key);
    }
    return current;
};

/**
 * The scalar `key` holds at this block's own indent level, with surrounding
 * quotes stripped. A key with no inline value (a nested block, or an empty
 * value) reads as undefined.
 *
 * Unquoting matters for the numeric reads: `max-ai-credits: "1000"` is valid
 * YAML, and passing the raw `"1000"` to `Number()` yields `NaN`, which compares
 * false against every threshold and silently suppresses the check.
 */
export const scalar = (
    lines: readonly YamlLine[],
    key: string,
): string | undefined => {
    if (lines.length === 0) {
        return undefined;
    }
    const base = baseIndent(lines);
    const hit = lines.find((line) => line.indent === base && line.key === key);
    return hit?.value === undefined || hit.value === ""
        ? undefined
        : unquote(hit.value);
};

/** True when `key` exists at this block's own indent level. */
export const hasKey = (lines: readonly YamlLine[], key: string): boolean => {
    if (lines.length === 0) {
        return false;
    }
    const base = baseIndent(lines);
    return lines.some((line) => line.indent === base && line.key === key);
};

/** The `- item` values of a block, in order, with surrounding quotes stripped. */
export const items = (lines: readonly YamlLine[]): string[] =>
    lines
        .map((line) => line.item)
        .filter((item): item is string => item !== undefined)
        .map(unquote);

/**
 * The list `key` holds, in either spelling: block style (`- item` lines nested
 * under the key) or flow style (`key: [a, b]`). Undefined only when the key is
 * absent, which is what lets a caller tell "no list here" from "a list that came
 * out empty" — the difference between a deliberate omission and a spelling this
 * reader could not read.
 *
 * Flow style is not an exotic case to skip: the shipped `review.md` writes
 * `toolsets: [pull_requests, repos]`, so a consumer copying that style into an
 * allowlist is writing perfectly ordinary frontmatter.
 */
export const list = (
    lines: readonly YamlLine[],
    key: string,
): string[] | undefined => {
    if (!hasKey(lines, key)) {
        return undefined;
    }
    const inline = scalar(lines, key);
    if (inline !== undefined) {
        if (!inline.startsWith("[") || !inline.endsWith("]")) {
            // A scalar where a list belongs: report it as unreadable rather than
            // as an empty list, so the caller does not mistake it for absence.
            return [];
        }
        return inline
            .slice(1, -1)
            .split(",")
            .map((entry) => unquote(entry))
            .filter((entry) => entry !== "");
    }
    return items(nested(lines, key) ?? []);
};
