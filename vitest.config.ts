import {configDefaults, defineConfig} from "vitest/config";

export default defineConfig({
    test: {
        watch: false,
        clearMocks: true,
        setupFiles: ["./config/tests/setup.ts"],
        // Live eval-corpus trees are case fixtures, not suite code: a tree
        // may legitimately carry a *.test.ts whose tests fail by design
        // (the test-adequacy cases), so vitest must never execute them.
        exclude: [
            ...configDefaults.exclude,
            "workflows/review/eval/corpus/**/tree/**",
        ],
    },
});
