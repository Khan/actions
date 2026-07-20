import {fetchPage, type Item} from "./paging";

const FAVORITES_PAGE_SIZE = 30;

export const favoriteItems = (
    items: Item[],
    favoriteIds: string[],
    page: number,
): Item[] => {
    const favorites = items.filter((item) => favoriteIds.includes(item.id));
    return fetchPage(favorites, page * FAVORITES_PAGE_SIZE, FAVORITES_PAGE_SIZE);
};
