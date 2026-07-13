/** Tiny process-local cache shared by the notes service. */
const store = new Map<string, unknown>();

export const cache = {
    set: (key: string, value: unknown): void => {
        store.set(key, value);
    },
    get: (key: string): unknown => store.get(key),
};
