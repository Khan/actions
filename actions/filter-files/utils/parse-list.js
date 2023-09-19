/**
 * Parse a list, that could be separated by commas or newlines.
 */
export default (raw) => {
    if (!raw || !raw.trim()) {
        return [];
    }
    if (!raw.includes(",") && !raw.includes("\n")) {
        return [raw];
    }
    let bracketCount = 0;
    const list = [];
    let current = "";
    // don't split on `,` inside brackets-- that breaks glob patterns
    // this builds an array of strings between commas and newlines,
    //   but not inside brackets
    for (const char of raw) {
        if (bracketCount < 0) {
            throw new Error("Unbalanced brackets in input");
        }
        if (char === " ") {
            continue;
        }
        if ((char === "," || char === "\n") && bracketCount === 0) {
            list.push(current);
            current = "";
            continue;
        }
        if (char === "(" || char === "[" || char === "{") {
            bracketCount++;
        }
        if (char === ")" || char === "]" || char === "}") {
            bracketCount--;
        }
        current += char;
    }
    if (current) {
        list.push(current);
    }
    if (bracketCount !== 0) {
        throw new Error("Unbalanced brackets");
    }
    return list.map((item) => item.trim());
};
