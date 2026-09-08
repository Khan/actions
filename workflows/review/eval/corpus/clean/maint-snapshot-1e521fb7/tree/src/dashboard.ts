import {stockCaption} from "./stock/caption";
import type {Catalog} from "./stock/catalog";
export const dashboard = (catalog: Catalog, sku: string) => ({caption: stockCaption(catalog, sku)});
