import {retryDelay, type Failure} from "./retry";
export const schedule = (failure: Failure) => retryDelay(failure);
