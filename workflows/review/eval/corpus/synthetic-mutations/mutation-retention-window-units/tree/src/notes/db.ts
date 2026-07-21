/** Minimal datastore facade the notes service shares. */
export type Note = {
    id: string;
    userId: string;
    content: string;
    /** Creation time, epoch milliseconds. */
    createdAt: number;
};

export type QueryOptions = {
    userId: string;
    orderDesc?: "createdAt";
    offset?: number;
    /** Rows per page. Defaults to 1 (a single-entity read). */
    pageSize?: number | "all";
};

export type Db = {
    put: (note: Note) => Promise<void>;
    query: (kind: "Note", options: QueryOptions) => Promise<Note[]>;
    /** Deletes one batch of notes by id. */
    deleteMulti: (ids: string[]) => Promise<void>;
};
