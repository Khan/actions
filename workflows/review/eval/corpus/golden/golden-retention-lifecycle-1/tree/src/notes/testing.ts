import type {Db, Note} from "./db";

let nextId = 0;

export const note = (userId: string, content: string): Note => ({
    id: `n-${nextId++}`,
    userId,
    content,
    createdAt: Date.now(),
});

/** In-memory Db honoring the facade's paging defaults. */
export const memDb = (): Db => {
    const rows: Note[] = [];
    return {
        put: async (row) => {
            rows.push(row);
        },
        query: async (_kind, options) => {
            let hits = rows.filter((row) => row.userId === options.userId);
            if (options.orderDesc === "createdAt") {
                hits = [...hits].sort((a, b) => b.createdAt - a.createdAt);
            }
            hits = hits.slice(options.offset ?? 0);
            const size = options.pageSize ?? 1;
            return size === "all" ? hits : hits.slice(0, size);
        },
        deleteMulti: async (ids) => {
            for (const id of ids) {
                const at = rows.findIndex((row) => row.id === id);
                if (at !== -1) {
                    rows.splice(at, 1);
                }
            }
        },
    };
};
