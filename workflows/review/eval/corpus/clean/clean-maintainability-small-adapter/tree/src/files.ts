import type {Dirent} from "node:fs";

export type ReportFs = {
    existsSync: (path: string) => boolean;
    mkdirSync: (path: string, options: {recursive: true}) => void;
    readdirSync: (path: string, options: {withFileTypes: true}) => Dirent[];
    readFileSync: (path: string, encoding: "utf8") => string;
    writeFileSync: (path: string, data: string) => void;
};
