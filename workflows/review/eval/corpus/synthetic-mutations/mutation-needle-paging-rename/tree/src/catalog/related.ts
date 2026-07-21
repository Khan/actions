import {fetchPage, type Item} from "./paging";

const RELATED_PAGE_SIZE = 4;

export const relatedItems = (items: Item[], toItem: Item): Item[] => {
    const others = items.filter((item) => item.id !== toItem.id);
    const byRank = [...others].sort((a, b) => b.rank - a.rank);
    return fetchPage(byRank, 0, RELATED_PAGE_SIZE);
};
