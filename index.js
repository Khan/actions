require('./sourcemap-register.js');/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	/* webpack/runtime/compat */
/******/ 	
/******/ 	if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = __dirname + "/";
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
// This entry need to be wrapped in an IIFE because it uses a non-standard name for the exports (exports).
(() => {
var exports = __webpack_exports__;

Object.defineProperty(exports, "__esModule", ({ value: true }));
const checkForChangeset = ({ context, core, inputFiles, }) => {
    if (!inputFiles.length) {
        return; // no relevant files changed, ignore
    }
    core.debug("Changed files: " + inputFiles);
    const branchName = context.payload.pull_request.head.ref;
    if (branchName === "changeset-release/main") {
        return; // release PRs don't need changesets.
    }
    const hasChangeset = inputFiles.some((name) => /^\.changeset\/.*\.md/.test(name));
    if (!hasChangeset) {
        core.setFailed("This PR does not have a changeset. You can add one by " +
            "running `pnpm changeset` and following the prompts.\n" +
            "If this PR doesn't need a changeset, run `pnpm changeset " +
            "--empty` and commit results.");
    }
};
exports["default"] = checkForChangeset;

})();

module.exports = __webpack_exports__;
/******/ })()
;
//# sourceMappingURL=index.js.map