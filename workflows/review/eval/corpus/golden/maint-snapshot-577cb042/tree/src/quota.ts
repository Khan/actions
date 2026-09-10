export type Quota = {remaining: number};
export const hasCapacity = (quota: Quota): boolean => {
    if (quota.remaining <= 0) return false;
    quota.remaining -= 1;
    return true;
};
