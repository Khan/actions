import {readFileSync} from "node:fs";
import {parseConfig} from "./parse";
import type {Config} from "./types";

export const loadConfig = (path: string, strict = false): Config =>
    parseConfig(readFileSync(path, "utf8"), strict);
