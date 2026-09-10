import {sendEmail, type Email} from "./email";

export interface NotificationSender {
    send(email: Email): Promise<void>;
}

class EmailSender implements NotificationSender {
    async send(email: Email): Promise<void> {
        await sendEmail(email);
    }
}

export class SenderRegistry {
    private readonly senders = new Map<string, NotificationSender>([
        ["email", new EmailSender()],
    ]);

    get(kind: string): NotificationSender {
        const sender = this.senders.get(kind);
        if (sender === undefined) {
            throw new Error(`no sender registered for "${kind}"`);
        }
        return sender;
    }
}
