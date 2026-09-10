import {hasCapacity, type Quota} from "./quota";
export const submit = (q: Quota) => hasCapacity(q);
