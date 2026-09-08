export type Row = {id: string; readings: {sensor: string; value: number}[]};
export const encodeRows = (rows: Row[], options: {envelope: boolean}): string => JSON.stringify(options.envelope ? {version: 1, rows} : rows);
