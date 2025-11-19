import {defineConfig} from "vitest/config";

export default defineConfig({
    test: {
        watch: false,
        clearMocks: true,
        setupFiles: ["./config/tests/setup.ts"],
    },
});
