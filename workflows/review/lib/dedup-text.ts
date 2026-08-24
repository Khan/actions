/**
 * The text-similarity primitives every dedup tier scores with: content
 * tokenization (lowercased alphanumerics, stopwords and short words
 * dropped), token bigrams, and set intersection — plus the calibrated
 * similarity floors, which are minimums over these exact definitions, so a
 * change to either re-opens every calibration note. Split from `dedup.ts`
 * for its max-lines budget (the dedup-cluster.ts precedent); the primitives
 * are dependency-free, and dedup.ts (the merge tiers) and dedup-threads.ts
 * (open-thread suppression) score with nothing else.
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

/**
 * Similarity floors, in two tiers. An identical `(path, line)` from two
 * sources is itself evidence of one defect, so that tier's token floors sit
 * just under the weakest real duplicate (run 30301235749's terse correctness
 * one-liner against the discursive holistic copy: 0.149 Jaccard, 0.346
 * overlap) and the shared-bigram floor carries the precision alone. A
 * DIFFERENT line is weak evidence of two defects, so that tier pays for the
 * looser anchor with a higher bigram floor: run 30301235749 merged the
 * skill-auditor's AddDate handoff at expiration.go:38 into the test-adequacy
 * missing-test todo at :62 on five shared bigrams, and both real
 * different-line duplicates (run 29943085279's expiration_test.go :15/:58
 * pair, and the bundled test-adequacy bridge) share six or more.
 *
 * Every floor is a minimum over real trial claims, so the margins are thin
 * by construction: the exact-anchor tier separates on bigrams 4 vs 3, the
 * other-line tier on 6 vs 5. Re-derive them from `dedup.test.ts`'s fixtures
 * rather than nudging them by feel.
 *
 * OTHER_LINE_FLOOR carries a SECOND calibration since the adjudicated pass
 * dropped its claim-side path key: it is also the cross-file floor for
 * `bestOpenThreadMatch({ignorePath: true})` (dedup-threads.ts), calibrated
 * on the frozen webapp#41290 family corpus, where the strongest cross-file
 * negative scores jaccard 0.168 against the 0.2 floor and the weakest true
 * match sits at exactly 7 shared bigrams. `dedup-adjudicated.test.ts` pins
 * both edges (the 7-bigram marginal match and a jaccard-only hard negative),
 * but a change to any number here must be re-derived against that corpus
 * too; see `bestOpenThreadMatch`'s doc.
 */
export const EXACT_ANCHOR_FLOOR = {
    jaccard: 0.14,
    overlap: 0.34,
    sharedBigrams: 4,
};
export const OTHER_LINE_FLOOR = {jaccard: 0.2, overlap: 0.35, sharedBigrams: 6};

/**
 * The floor for a claim with NO anchor at all (a pr-level finding) against
 * an open thread: the least anchor evidence dedup-threads.ts scores, so it pays
 * with the highest bigram floor, one tier above {@link OTHER_LINE_FLOOR}.
 * Calibrated on webapp#41290 review 4867627688 (a pr-anchored re-find of a
 * data race two open blocking threads tracked re-posted in full, because
 * the path gate made pr-level claims unsuppressable): the true counterparts
 * score 0.342/0.558/40 and 0.329/0.643/23 (jaccard/overlap/bigrams), the
 * six unrelated open threads top out at 0.051/0.180/1.
 * `dedup-pr-level.test.ts` carries the run's real texts; re-derive, don't nudge.
 */
export const PR_LEVEL_FLOOR = {jaccard: 0.2, overlap: 0.35, sharedBigrams: 8};
