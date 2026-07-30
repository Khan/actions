export type Row = {id: string; createdAt: number};

/** Offset paging over the reports table; the real client talks to pg. */
export const query = async (_opts: {
    limit: number;
    offset: number;
}): Promise<Row[]> => [];
