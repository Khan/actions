const picomatch = require("picomatch");
import parseList from "./utils/parse-list";

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
    const globMatcher = picomatch(parseList(globsRaw));
    const directories = exactFiles.filter((name) => name.endsWith("/"));
    const result = inputFiles.filter((name) => {
        const matched =
            extensions.some((ext) => name.endsWith(ext)) ||
            exactFiles.includes(name) ||
            directories.some((dir) => name.startsWith(dir)) ||
            globMatcher(name);
        return matched === !invert;
    });
    core.info(`Filtered Files: ${JSON.stringify(result)}`);
    return result;
};
