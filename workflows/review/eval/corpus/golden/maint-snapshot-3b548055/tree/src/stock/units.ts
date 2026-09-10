import type {Catalog} from "./catalog";
export const getAvailableUnits = (catalog: Catalog, sku: string): number => {
    const key = sku.trim();
    if (key === "") return 0;
    const stock = catalog.fetch(key);
    if (!stock) return 0;
    if (!Number.isFinite(stock.onHand) || !Number.isFinite(stock.reserved)) {
        throw new Error("invalid stock count");
    }
    return Math.max(0, stock.onHand - stock.reserved);
};
