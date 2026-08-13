/**
 * The text-similarity primitives every dedup tier scores with: content
 * tokenization (lowercased alphanumerics, stopwords and short words
 * dropped), token bigrams, and set intersection. Split from `dedup.ts` for
 * its max-lines budget (the dedup-cluster.ts precedent); they are
 * dependency-free and every floor in dedup.ts (same-line, other-line,
 * pr-level) is calibrated against exactly these definitions, so a change
 * here re-opens every calibration note there.
 */

const STOPWORDS = new Set(
    "the a an and or of to in is are was be for on with that this it as not no by at from so its their they".split(
        " ",
    ),
);

export const contentTokens = (text: string): string[] => {
    const tokens: string[] = [];
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        if (word.length >= 3 && !STOPWORDS.has(word)) {
            tokens.push(word);
        }
    }
    return tokens;
};

export const bigrams = (tokens: string[]): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i + 1 < tokens.length; i += 1) {
        set.add(`${tokens[i]} ${tokens[i + 1]}`);
    }
    return set;
};

export const intersectionSize = <T>(a: Set<T>, b: Set<T>): number => {
    let count = 0;
    for (const item of a) {
        if (b.has(item)) {
            count += 1;
        }
    }
    return count;
};
