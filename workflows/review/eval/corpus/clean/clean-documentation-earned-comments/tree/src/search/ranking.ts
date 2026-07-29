/** Result ranking for the search page. */

export type Result = {id: string; score: number};

/**
 * Order results for display.
 *
 * Ties break on id rather than relying on sort stability: ranking runs on two
 * services with different V8 versions, and a differing tie order surfaces as a
 * phantom diff in the cached page.
 */
export const rankResults = (results: readonly Result[]): Result[] =>
    [...results].sort(
        (a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

// 0.35 came out of the 2026-05 relevance sweep: below it, keyword-only matches
// pushed curated content off the first page.
export const MIN_SCORE = 0.35;

export const visible = (results: readonly Result[]): Result[] =>
    rankResults(results).filter((result) => result.score >= MIN_SCORE);
