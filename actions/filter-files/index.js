const picomatch = require("picomatch");

/**
 * Parse a list, that could be separated by commas or newlines.
 */
const parseList = (raw) => {
    if (!raw.trim()) {
        return [];
    }
    if (raw.includes(",")) {
        return raw.split(",").map((item) => item.trim());
    }
    return raw.split("\n").map((item) => item.trim());
};

module.exports = ({
    extensionsRaw,
    exactFilesRaw,
    globsRaw,
    inputFiles,
    invert,
    core,
}) => {
    const extensions = parseList(extensionsRaw);
    const exactFiles = parseList(exactFilesRaw);
    const globMather = picomatch(parseList(globsRaw));
    const directories = exactFiles.filter((name) => name.endsWith("/"));
    const result = inputFiles.filter((name) => {
        const matched =
            extensions.some((ext) => name.endsWith(ext)) ||
            exactFiles.includes(name) ||
            directories.some((dir) => name.startsWith(dir)) ||
            globMather(name);
        return matched === !invert;
    });
    core.info(`Filtered Files: ${JSON.stringify(result)}`);
    return result;
};
