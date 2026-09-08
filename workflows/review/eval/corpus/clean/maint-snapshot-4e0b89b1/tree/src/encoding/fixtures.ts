import type {Row} from "./encode";
export const rowFixture = (): Row[] => {
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
    return rows;
};
