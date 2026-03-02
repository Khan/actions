type FilterFilesInput = {
    extensionsRaw?: string;
    exactFilesRaw?: string;
    globsRaw?: string;
    inputFiles: string[];
    invert?: boolean;
    conjunctive?: boolean;
    matchAllGlobs?: boolean;
    core: {
        info: (message: string) => void;
    };
};

declare function filterFiles(input: FilterFilesInput): string[];

export = filterFiles;
