/** Standard email shell: preheader, body slot, unsubscribe footer. */
export const wrapHtml = (body: string): string =>
    [
        `<html><body style="font-family: sans-serif">`,
        body,
        `<footer><a href="{{unsubscribe_url}}">Manage notification settings</a></footer>`,
        `</body></html>`,
    ].join("\n");
