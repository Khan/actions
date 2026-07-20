import {fetchPage, type Item} from "./paging";

const RECENT_PAGE_SIZE = 25;

export const recentItems = (items: Item[], page: number): Item[] => {
    const active = items.filter((item) => !item.archived);
    return fetchPage(active, page * RECENT_PAGE_SIZE, RECENT_PAGE_SIZE);
};
