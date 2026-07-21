import type {Digest} from "../digest/assemble";
import {emailFor} from "../users/directory";
import {sendEmail} from "./transport";

/**
 * Digest delivery goes straight to the transport: the digest is one email,
 * already assembled, so the per-item send pipeline does not apply.
 */
export const sendBatch = async (digest: Digest): Promise<void> => {
    await sendEmail({
        to: emailFor(digest.userId),
        subject: digest.subject,
        html: digest.html,
    });
};
