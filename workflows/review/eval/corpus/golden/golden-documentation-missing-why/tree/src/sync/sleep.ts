/** Resolve after `ms`; the sync retry loop's only timing dependency. */
export const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
