import type {Catalog} from "./catalog";
export const stockCaption = (catalog: Catalog, sku: string): string => {
    const key = sku.trim();
    if (key === "") return "Unknown item";
    const stock = catalog.fetch(key);
    if (!stock) return "Unknown item";
    if (!Number.isFinite(stock.onHand) || !Number.isFinite(stock.reserved)) {
        throw new Error("invalid stock count");
    }
    const available = Math.max(0, stock.onHand - stock.reserved);
    return available > 0 ? `${available} available` : "Out of stock";
};
