import {encodeAttachment} from "./encode";
export const sendAttachment = (text: string, compact = false): string => encodeAttachment(text, compact);
