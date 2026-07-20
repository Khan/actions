import {fetchPage, type Item} from "./paging";

const TRENDING_PAGE_SIZE = 12;

export const trendingItems = (items: Item[], page: number): Item[] => {
    const active = items.filter((item) => !item.archived);
    const byRank = [...active].sort((a, b) => b.rank - a.rank);
    return fetchPage(byRank, page * TRENDING_PAGE_SIZE, TRENDING_PAGE_SIZE);
};
