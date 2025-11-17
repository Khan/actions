/**
 * This is a very stripped-down eslintrc, because @khanacademy/eslint-config
 * assumes you're using react & flow (and requires a lot of dependencies along
 * with it).
 */
const khan = require("@khanacademy/eslint-config");

// Only keep the rules that have no prefix (so are included in eslint core)
// and the prettier rule.
const basicRules = {};
Object.keys(khan.rules).forEach((key) => {
    if (!key.includes("/") || key.startsWith("prettier/")) {
        basicRules[key] = khan.rules[key];
    }
});

module.exports = {
    extends: ["eslint:recommended", "prettier"],
    plugins: ["prettier"],
    rules: basicRules,
    env: {
        node: true,
    },
    parserOptions: {
        sourceType: "module",
        ecmaVersion: 2022,
    },
    overrides: [
        {
            files: "utils/*",
            rules: {
                "no-console": "off",
            },
        },
    ],
};
