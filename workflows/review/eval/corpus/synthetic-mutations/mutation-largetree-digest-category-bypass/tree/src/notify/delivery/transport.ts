export type Email = {
    to: string;
    subject: string;
    html: string;
};

const outbox: Email[] = [];

/** Hands the email to the provider; retried by retry.ts on failure. */
export const sendEmail = async (email: Email): Promise<void> => {
    outbox.push(email);
};

export const sentEmails = (): readonly Email[] => outbox;
