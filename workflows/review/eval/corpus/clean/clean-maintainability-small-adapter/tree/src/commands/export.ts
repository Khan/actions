import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import type {ReportFs} from "../files";

const EXPORT_FS: ReportFs = {
    existsSync,
    mkdirSync: (path, options) => {
        mkdirSync(path, options);
    },
    readdirSync: (path, options) => readdirSync(path, options),
    readFileSync: (path, encoding) => readFileSync(path, encoding),
    writeFileSync: (path, data) => {
        writeFileSync(path, data);
    },
};

export const exportReport = (input: string, output: string, fs: ReportFs = EXPORT_FS): void => {
    const report: unknown = JSON.parse(fs.readFileSync(input, "utf8"));
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
};
