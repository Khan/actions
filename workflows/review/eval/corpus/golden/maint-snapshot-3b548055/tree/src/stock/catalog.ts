export type Stock = {onHand: number; reserved: number};
export interface Catalog {fetch(sku: string): Stock | undefined;}
