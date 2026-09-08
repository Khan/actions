import {encodeRows, type Row} from "./encode";
export const verifyPlainRows = (): void => {
    const rows: Row[] = [
        {
            id: "north",
            readings: [
                {sensor: "temperature", value: 12},
                {sensor: "humidity", value: 65},
            ],
        },
        {
            id: "south",
            readings: [
                {sensor: "temperature", value: 21},
                {sensor: "humidity", value: 40},
            ],
        },
        {
            id: "west",
            readings: [
                {sensor: "temperature", value: -3},
                {sensor: "humidity", value: 82},
            ],
        },
    ];
    const actual = JSON.parse(encodeRows(rows, {envelope: false}));
    if (JSON.stringify(actual) !== JSON.stringify(rows)) throw new Error("plain rows changed");
};

export const verifyEnvelopeRows = (): void => {
    const rows: Row[] = [
        {
            id: "north",
            readings: [
                {sensor: "temperature", value: 12},
                {sensor: "humidity", value: 65},
            ],
        },
        {
            id: "south",
            readings: [
                {sensor: "temperature", value: 21},
                {sensor: "humidity", value: 40},
            ],
        },
        {
            id: "west",
            readings: [
                {sensor: "temperature", value: -3},
                {sensor: "humidity", value: 82},
            ],
        },
    ];
    const actual = JSON.parse(encodeRows(rows, {envelope: true}));
    if (actual.version !== 1) throw new Error("wrong version");
    if (JSON.stringify(actual.rows) !== JSON.stringify(rows)) throw new Error("envelope rows changed");
};
