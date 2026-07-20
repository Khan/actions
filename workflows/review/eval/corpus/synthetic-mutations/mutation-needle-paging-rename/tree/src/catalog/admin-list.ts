import {fetchPage, type Item} from "./paging";

const ADMIN_PAGE_SIZE = 100;

/** Admin console listing: unfiltered, newest id first. */
export const adminList = (items: Item[], page: number): Item[] => {
    const byId = [...items].sort((a, b) => b.id.localeCompare(a.id));
    return fetchPage(byId, page * ADMIN_PAGE_SIZE, ADMIN_PAGE_SIZE);
};
