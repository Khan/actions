import {fetchPage, type Item} from "./paging";

const SEARCH_PAGE_SIZE = 10;

export const searchItems = (
    items: Item[],
    query: string,
    page: number,
): Item[] => {
    const hits = items.filter((item) =>
        item.title.toLowerCase().includes(query.toLowerCase()),
    );
    return fetchPage(hits, page * SEARCH_PAGE_SIZE, SEARCH_PAGE_SIZE);
};
