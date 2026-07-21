import {fetchPage, type Item} from "./paging";

const PINNED_PAGE_SIZE = 3;

export const pinnedItems = (items: Item[], pinnedIds: string[]): Item[] => {
    const pinned = items.filter((item) => pinnedIds.includes(item.id));
    const byRank = [...pinned].sort((a, b) => b.rank - a.rank);
    return fetchPage(byRank, 0, PINNED_PAGE_SIZE);
};
