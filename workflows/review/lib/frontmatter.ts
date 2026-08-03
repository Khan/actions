/**
 * A minimal structural reader for gh-aw markdown frontmatter: indentation,
 * `key:` and `- item`, nothing else.
 *
 * Deliberately not a YAML parser. `lib/` carries no YAML dependency (its
 * `package.json` pins exactly what the thumbs sweep needs), and every question
 * asked of frontmatter here (is this key present, what scalar does it hold,
 * what list items sit under it) is answerable from the shape of gh-aw
 * frontmatter, which is plain block-style mappings.
 *
 * One behaviour is load-bearing rather than incidental: comment lines are
 * dropped, so a commented-out block reads as **absent**. That is exactly the
 * intended meaning, because commenting a block out is how a consumer disables
 * one (the `observability:` local edit the reviewer's README prescribes for a
 * repo without the `GH_AW_OTEL_SENTRY_*` secrets).
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

/** Reduce a block to {@link YamlLine}s, dropping blanks and comments. */
export const yamlLines = (block: string): YamlLine[] =>
    block
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
        .map((line) => {
            const indent = line.length - line.trimStart().length;
            const trimmed = line.trim();
            if (trimmed.startsWith("- ")) {
                return {indent, item: trimmed.slice(2).trim()};
            }
            const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(trimmed);
            return match
                ? {indent, key: match[1], value: match[2].trim()}
                : {indent};
        });

/** The base (outermost) indent of a block's own keys. */
const baseIndent = (lines: readonly YamlLine[]): number =>
    Math.min(...lines.map((line) => line.indent));

/** The lines nested under `key` at this block's own indent level. */
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
            for (
                let j = i + 1;
                j < lines.length && lines[j].indent > base;
                j++
            ) {
                out.push(lines[j]);
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
 * The scalar `key` holds at this block's own indent level. A key with no inline
 * value (a nested block, or an empty value) reads as undefined.
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
    return hit?.value === "" ? undefined : hit?.value;
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
        .map((item) => item.replace(/^["']|["']$/g, ""));
