import * as picomatch from "picomatch";

type CoreLike = {
    info: (message: string) => void;
};

type FilterFilesInput = {
    extensionsRaw?: string;
    exactFilesRaw?: string;
    globsRaw?: string;
    inputFiles: string[];
    invert?: boolean;
    conjunctive?: boolean;
    matchAllGlobs?: boolean;
    core: CoreLike;
};

const err = new Error("Unbalanced brackets in input");

const parseList = (raw: string): string[] => {
    if (!raw || !raw.trim()) {
        return [];
    }
    if (!raw.includes(",") && !raw.includes("\n")) {
        return [raw];
    }
    if (raw.includes("\n")) {
        // if split on newlines, no need to parse for internal commas
        return (
            raw
                .split("\n")
                .map((item) => item.trim())
                // Filter out comment lines
                .filter((line) => line.length > 0 && !line.startsWith("#"))
        );
    }

    let bracketCount = 0;
    const list: string[] = [];
    let current = "";
    // don't split on `,` inside brackets-- that breaks glob patterns
    // this builds an array of strings between commas and newlines,
    //   but not inside brackets
    for (const char of raw) {
        if (bracketCount < 0) {
            throw err;
        }
        switch (char) {
            case ",":
                // if we're not inside brackets, add the current string to the list
                //   and reset the current string
                if (bracketCount === 0) {
                    list.push(current.trim());
                    current = "";
                    continue;
                }
                break;
            case "(":
            case "[":
            case "{":
                // increment the bracket count
                bracketCount += 1;
                break;
            case ")":
            case "]":
            case "}":
                // decrement the bracket count
                bracketCount -= 1;
                break;
        }
        current += char;
    }

    if (current) {
        list.push(current.trim());
    }
    if (bracketCount !== 0) {
        throw err;
    }
    return list.map((item) => item.trim());
};

const filterFiles = ({
    extensionsRaw = "",
    exactFilesRaw = "",
    globsRaw = "",
    inputFiles,
    invert = false,
    conjunctive = false,
    matchAllGlobs = false,
    core,
}: FilterFilesInput): string[] => {
    const filters: Array<(path: string) => boolean> = [];

    if (exactFilesRaw) {
        const paths = parseList(exactFilesRaw);
        const [directories, exactFiles] = paths.reduce<[string[], string[]]>(
            ([dirs, files], path) =>
                path.endsWith("/")
                    ? [[...dirs, path], files]
                    : [dirs, [...files, path]],
            [[], []],
        );

        if (directories.length) {
            filters.push((path) =>
                directories.some((dir) => path.startsWith(dir)),
            );
        }
        if (exactFiles.length) {
            filters.push((path) => exactFiles.includes(path));
        }
    }

    if (extensionsRaw) {
        const extensions = parseList(extensionsRaw);
        filters.push((path) => extensions.some((ext) => path.endsWith(ext)));
    }

    if (globsRaw) {
        const globsList = parseList(globsRaw);
        // picomatch does does inclusive disjunctions (ORs) by default,
        //   so we need to do some extra work to get conjunctive (AND) matches.
        // test this behavior here: https://codesandbox.io/s/picomatch-forked-qgqy2g
        if (globsList.length > 1 && matchAllGlobs) {
            // conjunctive glob match
            const matchers = globsList.map((glob) => picomatch(glob));
            filters.push((path) => matchers.every((matcher) => matcher(path)));
        } else {
            const nots = globsList.filter((glob) => glob.startsWith("!"));
            if (nots.length) {
                const yeses = globsList.filter((glob) => !glob.startsWith("!"));
                filters.push((path) => {
                    const yesesMatch =
                        yeses.length === 0 ||
                        yeses.some((glob) => picomatch(glob)(path));
                    const noesMatch = nots.every((glob) =>
                        picomatch(glob)(path),
                    );
                    return yesesMatch && noesMatch;
                });
            } else {
                // disjunctive glob match
                filters.push((path) => picomatch(globsList)(path));
            }
        }
    }

    const result = inputFiles.filter((name) => {
        const bools = filters.map((conditional) => conditional(name));
        const matched = conjunctive
            ? bools.every(Boolean)
            : bools.some(Boolean);
        return matched === !invert;
    });

    core.info(`Filtered Files: ${JSON.stringify(result)}`);
    return result;
};

export default filterFiles;
