import {fetchPage, type Item} from "./paging";

const DIGEST_PAGE_SIZE = 20;

/** Items for the weekly email digest: newest first, one page. */
export const digestItems = (items: Item[]): Item[] => {
    const active = items.filter((item) => !item.archived);
    const byRank = [...active].sort((a, b) => b.rank - a.rank);
    return fetchPage(byRank, DIGEST_PAGE_SIZE, 0);
};
