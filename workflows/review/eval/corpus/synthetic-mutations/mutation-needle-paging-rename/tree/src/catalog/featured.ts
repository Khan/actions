import {fetchPage, type Item} from "./paging";

const FEATURED_PAGE_SIZE = 6;

export const featuredItems = (items: Item[]): Item[] => {
    const byRank = [...items].sort((a, b) => b.rank - a.rank);
    return fetchPage(byRank, 0, FEATURED_PAGE_SIZE);
};
