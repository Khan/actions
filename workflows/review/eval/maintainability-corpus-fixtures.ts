import {createHash} from "node:crypto";
import {readFileSync, readdirSync} from "node:fs";
import {resolve} from "node:path";
import {runInNewContext} from "node:vm";
import ts from "typescript";
import {loadCorpus} from "./corpus/loader";

export type CorpusEntry = {
    id: string;
    name: string;
    family: string;
    kind: string;
    partition: string;
    casePath: string;
    caseSha256: string;
    tree: Record<string, string>;
    before: Record<string, string>;
    provenance: {origin: string; notHistorical: boolean};
};
export const manifest = JSON.parse(
    readFileSync(`${__dirname}/maintainability-corpus-manifest.json`, "utf8"),
) as {
    promptSectionSha256: string;
    entries: CorpusEntry[];
    negativeWitnesses: Record<string, string>;
};
export const cases = loadCorpus().filter((c) =>
    c.tags.includes("maintainability-expanded"),
);
export const caseNamed = (name: string) => {
    const entry = manifest.entries.find((e) => e.name === name);
    const corpusCase = cases.find((c) => c.id === entry?.id);
    if (!entry || !corpusCase) {
        throw new Error(`unknown corpus entry: ${name}`);
    }
    return {entry, corpusCase, root: resolve(entry.casePath, "tree")};
};
export const hash = (s: string): string =>
    createHash("sha256").update(s).digest("hex");
export const filesUnder = (dir: string, prefix = ""): string[] =>
    readdirSync(dir, {withFileTypes: true})
        .flatMap((e) =>
            e.isDirectory()
                ? filesUnder(`${dir}/${e.name}`, `${prefix}${e.name}/`)
                : [`${prefix}${e.name}`],
        )
        .sort();
export const programFor = (root: string) =>
    ts.createProgram(
        ts.sys.readDirectory(root, [".ts"], undefined, ["**/*.ts"]),
        {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
            moduleResolution: ts.ModuleResolutionKind.Node10,
            types: [],
        },
    );

/** Execute only the authored TypeScript examples, with local relative imports. */
export const authoredModules = (name: string) => {
    const {entry, root} = caseNamed(name);
    if (entry.kind !== "authored") {
        throw new Error(
            "source snapshots are read-only data, not executable test modules",
        );
    }
    const cache = new Map<string, {exports: Record<string, any>}>();
    const load = (path: string): Record<string, any> => {
        const absolute = resolve(
            root,
            path.endsWith(".ts") ? path : `${path}.ts`,
        );
        if (!absolute.startsWith(`${root}/`)) {
            throw new Error("module outside fixture tree");
        }
        const prior = cache.get(absolute);
        if (prior) {
            return prior.exports;
        }
        const module = {exports: {}};
        cache.set(absolute, module);
        const source = readFileSync(absolute, "utf8");
        const js = ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.CommonJS,
            },
        }).outputText;
        const localRequire = (request: string) => {
            if (!request.startsWith(".")) {
                throw new Error("fixture cannot import external modules");
            }
            return load(resolve(absolute, "..", request));
        };
        runInNewContext(
            js,
            {require: localRequire, module, exports: module.exports},
            {timeout: 1000, filename: absolute},
        );
        return module.exports;
    };
    return load;
};
