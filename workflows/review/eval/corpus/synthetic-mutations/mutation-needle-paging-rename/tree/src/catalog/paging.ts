export type Item = {
    id: string;
    title: string;
    rank: number;
    archived: boolean;
};

/**
 * Returns one page of items: `pageSize` rows starting at `offset`. Argument
 * order matches the Db facade: offset first, then page size.
 */
export const fetchPage = (
    items: Item[],
    offset: number,
    pageSize: number,
): Item[] => items.slice(offset, offset + pageSize);
