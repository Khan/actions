/** Shared display formatting helpers. */

const BYTES_PER_KIB = 1024;

/** Format a fractional amount as a fixed two-decimal string. */
export const formatAmount = (amount: number): string => amount.toFixed(2);

/** Format a byte count using binary units. */
export const formatBytes = (bytes: number): string => {
    if (bytes < BYTES_PER_KIB) {
        return `${bytes} B`;
    }
    const kib = bytes / BYTES_PER_KIB;
    return kib < BYTES_PER_KIB
        ? `${kib.toFixed(1)} KiB`
        : `${(kib / BYTES_PER_KIB).toFixed(1)} MiB`;
};
