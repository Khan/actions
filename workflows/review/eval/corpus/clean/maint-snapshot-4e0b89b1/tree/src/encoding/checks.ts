import {encodeRows} from "./encode";
import {rowFixture} from "./fixtures";
export const verifyPlainRows = (): void => {
    const rows = rowFixture();
    const actual = JSON.parse(encodeRows(rows, {envelope: false}));
    if (JSON.stringify(actual) !== JSON.stringify(rows)) throw new Error("plain rows changed");
};

export const verifyEnvelopeRows = (): void => {
    const rows = rowFixture();
    const actual = JSON.parse(encodeRows(rows, {envelope: true}));
    if (actual.version !== 1) throw new Error("wrong version");
    if (JSON.stringify(actual.rows) !== JSON.stringify(rows)) throw new Error("envelope rows changed");
};
