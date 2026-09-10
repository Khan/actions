import type {Catalog} from "./catalog";
import {readAvailable} from "./read";
export const stockCaption = (catalog: Catalog, sku: string): string => {
    const available = readAvailable(catalog, sku);
    if (available === null) return "Unknown item";
    return available > 0 ? `${available} available` : "Out of stock";
};
