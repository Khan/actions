import {MailTransport} from "./transport";
const transport = new MailTransport();
export const deliver = (body: string): string => transport.send(body);
