import {encodeAttachment} from "./encode";
import type {AttachmentOptions} from "./options";
export const sendAttachment = (text: string, options: AttachmentOptions): string => encodeAttachment(options.whitespace === "collapse" ? text.replace(/\s+/g, " ") : text);
