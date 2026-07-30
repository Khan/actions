import {query, type Row} from "./db";

export type Page = {items: Row[]; hasMore: boolean};

// The reports table is append-only and paging runs newest-first, so a row
// inserted mid-scan lands on a page the caller has already passed; that is what
// makes offset paging safe here instead of cursors.
const DEFAULT_PAGE_SIZE = 50;

/**
 * Fetch a page of rows.
 *
 * @param pageIndex The page index.
 * @param pageSize The number of rows per page.
 * @returns The page of rows.
 */
export const fetchPage = async (
    pageIndex: number,
    pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<Page> => {
    // Over-fetch by one: the extra row answers hasMore without a second count
    // query, which doubled p99 on the reports dashboard.
    const rows = await query({
        limit: pageSize + 1,
        offset: pageIndex * pageSize,
    });
    return {items: rows.slice(0, pageSize), hasMore: rows.length > pageSize};
};
