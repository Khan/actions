/**
 * Match gh-aw v0.85.4's applyToNonCodeRegions boundary: exact-length inline
 * backticks and line-based backtick or tilde fences. An unclosed fence keeps
 * the remainder as code, while an unmatched inline opener remains prose.
 * Only the selected transform is skipped, not the rest of normalization.
 */
const outsideInlineCode = (
    text: string,
    transform: (prose: string) => string,
): string => {
    const ticks = [...text.matchAll(/`+/g)];
    let start = 0;
    let result = "";
    for (let i = 0; i < ticks.length; i++) {
        const open = ticks[i];
        let close = i + 1;
        while (
            close < ticks.length &&
            ticks[close][0].length !== open[0].length
        ) {
            close++;
        }
        if (close === ticks.length) {
            continue;
        }
        const end = ticks[close].index + ticks[close][0].length;
        result += transform(text.slice(start, open.index));
        result += text.slice(open.index, end);
        start = end;
        i = close;
    }
    return result + transform(text.slice(start));
};

export const outsideCodeRegions = (
    text: string,
    transform: (prose: string) => string,
): string => {
    const parts: string[] = [];
    let prose = "";
    let fence: string | undefined;
    for (const line of text.split(/(?<=\n)/)) {
        const trimmed = line.trim();
        if (fence === undefined) {
            const opening = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
            if (opening === undefined) {
                prose += line;
                continue;
            }
            parts.push(outsideInlineCode(prose, transform));
            prose = "";
            fence = opening;
        } else {
            const closing = /^(`{3,}|~{3,})\s*$/.exec(trimmed)?.[1];
            if (
                closing &&
                closing[0] === fence[0] &&
                closing.length >= fence.length
            ) {
                fence = undefined;
            }
        }
        parts.push(line);
    }
    parts.push(outsideInlineCode(prose, transform));
    return parts.join("");
};
