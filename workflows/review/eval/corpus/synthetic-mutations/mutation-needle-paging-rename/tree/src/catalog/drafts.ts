import {fetchPage, type Item} from "./paging";

const DRAFTS_PAGE_SIZE = 15;

/** Unranked drafts listing, insertion order. */
export const draftItems = (drafts: Item[], page: number): Item[] =>
    fetchPage(drafts, page * DRAFTS_PAGE_SIZE, DRAFTS_PAGE_SIZE);
