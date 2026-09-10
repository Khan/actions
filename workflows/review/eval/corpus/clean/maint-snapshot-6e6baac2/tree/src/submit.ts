import {reserveCapacity, type Quota} from "./quota";
export const submit = (q: Quota) => reserveCapacity(q);
