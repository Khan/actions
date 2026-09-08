import type {Catalog} from "./catalog";
import {readAvailable} from "./read";
export const getAvailableUnits = (catalog: Catalog, sku: string): number => readAvailable(catalog, sku) ?? 0;
