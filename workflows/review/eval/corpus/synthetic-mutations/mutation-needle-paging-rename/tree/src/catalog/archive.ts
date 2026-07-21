import {fetchPage, type Item} from "./paging";

const ARCHIVE_PAGE_SIZE = 50;

export const archivedItems = (items: Item[], page: number): Item[] => {
    const archived = items.filter((item) => item.archived);
    return fetchPage(archived, page * ARCHIVE_PAGE_SIZE, ARCHIVE_PAGE_SIZE);
};
