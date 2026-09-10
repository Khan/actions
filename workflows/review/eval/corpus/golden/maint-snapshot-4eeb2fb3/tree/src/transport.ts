import {sendMail} from "./mail";
export interface Transport {send(body: string): string;}
export class MailTransport implements Transport {
    send(body: string): string {return sendMail(body);}
}
