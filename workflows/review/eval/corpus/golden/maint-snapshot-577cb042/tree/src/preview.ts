import {hasCapacity, type Quota} from "./quota";
export const preview = (q: Quota) => ({enabled: hasCapacity(q)});
