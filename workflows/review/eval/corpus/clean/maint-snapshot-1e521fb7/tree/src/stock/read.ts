import type {Catalog} from "./catalog";
export const readAvailable = (catalog: Catalog, sku: string): number | null => {
    const key = sku.trim();
    if (key === "") return null;
    const stock = catalog.fetch(key);
    if (!stock) return null;
    if (!Number.isFinite(stock.onHand) || !Number.isFinite(stock.reserved)) {
        throw new Error("invalid stock count");
    }
    return Math.max(0, stock.onHand - stock.reserved);
};
