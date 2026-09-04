export type Email = {to: string; subject: string; body: string};

export const sendEmail = async (email: Email): Promise<void> => {
    await fetch("https://mail.internal/send", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(email),
    });
};
