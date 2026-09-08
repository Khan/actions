import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import type {ReportFs} from "../files";

const PREVIEW_FS: ReportFs = {
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

export const previewReport = (input: string, fs: ReportFs = PREVIEW_FS): unknown =>
    JSON.parse(fs.readFileSync(input, "utf8"));
