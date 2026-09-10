import {deliver} from "./delivery";
export const preview = (body: string) => deliver({send: (text) => `preview:${text}`}, body);
