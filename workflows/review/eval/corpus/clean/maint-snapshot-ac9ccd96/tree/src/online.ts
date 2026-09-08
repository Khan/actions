import {deliver} from "./delivery";
import {sendMail} from "./mail";
export const online = (body: string) => deliver({send: sendMail}, body);
