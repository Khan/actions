/** Shared display formatting helpers. */

/** Format a fractional amount as a fixed two-decimal string. */
export const formatAmount = (amount: number): string => amount.toFixed(2);

/** Format a byte count using binary units. */
export const formatBytes = (bytes: number): string => {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const kib = bytes / 1024;
    return kib < 1024 ? `${kib.toFixed(1)} KiB` : `${(kib / 1024).toFixed(1)} MiB`;
};
