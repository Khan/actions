export type Quota = {remaining: number};
export const hasCapacity = (quota: Quota): boolean => quota.remaining > 0;
export const reserveCapacity = (quota: Quota): boolean => {
    if (!hasCapacity(quota)) return false;
    quota.remaining -= 1;
    return true;
};
