/**
 * The one srt-drain exit path for every eval CLI entry point (live-ab,
 * sandbox-smoke, harness-probe). srt's SandboxManager keeps a non-daemon
 * monitor alive, so a finished eval process hangs instead of exiting; a
 * PASSED run that presents as a hung job is worse than a failure, because the
 * check never resolves either way.
 *
 * Draining first, rather than a bare process.exit: Actions gives this process
 * a pipe, writes to a pipe are asynchronous, and exiting on top of a buffered
 * write truncates the last lines of the very table the job exists to print.
 * The unref'd fallback covers a drain callback that never fires.
 *
 * One copy on purpose: this workaround is load-bearing and coupled to srt's
 * behavior, and three byte-identical copies were already drifting candidates
 * before they were folded here.
 */
export const exitWhenFlushed = (code: number): void => {
    const done = (): never => process.exit(code);
    setTimeout(done, 2000).unref();
    process.stdout.write("", done);
};

/** Run a CLI main() and exit through the drain path on either outcome. */
export const runCli = (main: () => Promise<unknown>): void => {
    main().then(
        () => exitWhenFlushed(0),
        (error: unknown) => {
            // eslint-disable-next-line no-console
            console.error(error);
            exitWhenFlushed(1);
        },
    );
};
