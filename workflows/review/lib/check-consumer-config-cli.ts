/**
 * The consumer-config checker's CLI: argument parsing and the direct-run
 * entry point.
 *
 * Split from check-consumer-config.ts by the same max-lines budget that moved
 * the report rendering into check-consumer-config-report.ts. The documented
 * invocation stays `npx -y tsx workflows/review/lib/check-consumer-config.ts`:
 * that module re-exports {@link parseArgs} and keeps the require.main guard,
 * calling {@link runCli} here only when invoked directly.
 */
import {checkConsumerConfig} from "./check-consumer-config";
import type {ConsumerConfigFs} from "./check-consumer-config";
import {renderReport} from "./check-consumer-config-report";
import {frontmatterBlock, scalar, yamlLines} from "./frontmatter";

type CliArgs = {
    repoRoot?: string;
    filesFrom?: string;
    explainPath?: string;
    workflowPath?: string;
    json: boolean;
    strict: boolean;
};

/** Parse `--flag value` arguments. Unknown flags are an error, not ignored. */
export const parseArgs = (argv: readonly string[]): CliArgs => {
    const out = {json: false, strict: false} as CliArgs;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case "--repo":
                out.repoRoot = argv[++i];
                break;
            case "--files-from":
                out.filesFrom = argv[++i];
                break;
            case "--explain":
                out.explainPath = argv[++i];
                break;
            case "--workflow":
                out.workflowPath = argv[++i];
                break;
            case "--json":
                out.json = true;
                break;
            case "--strict":
                out.strict = true;
                break;
            default:
                throw new Error(`unknown argument: ${arg}`);
        }
    }
    return out;
};

export const runCli = (): void => {
    /* eslint-disable-next-line no-undef */
    const nodeFs = require("node:fs") as ConsumerConfigFs & {
        readFileSync: (p: string | number, enc: "utf8") => string;
    };
    const args = parseArgs(process.argv.slice(2));

    const files =
        args.filesFrom === undefined
            ? undefined
            : nodeFs
                  .readFileSync(
                      args.filesFrom === "-" ? 0 : args.filesFrom,
                      "utf8",
                  )
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line !== "");

    // The version this checker ships with, so a consumer pinned elsewhere is
    // told the semantics validated here are not the ones its reviews run.
    let checkerVersion: string | undefined;
    try {
        checkerVersion = JSON.parse(
            nodeFs.readFileSync(`${__dirname}/../package.json`, "utf8"),
        ).version;
    } catch {
        checkerVersion = undefined;
    }

    // The ceiling the shared workflow ships, read from this checkout's own
    // review.md so a release that raises it cannot strand the hardcoded
    // fallback constant.
    let shippedMaxAiCredits: number | undefined;
    try {
        const shipped = frontmatterBlock(
            nodeFs.readFileSync(`${__dirname}/../review.md`, "utf8"),
        );
        const raw =
            shipped === undefined
                ? undefined
                : scalar(yamlLines(shipped), "max-ai-credits");
        const parsed = raw === undefined ? NaN : Number(raw);
        shippedMaxAiCredits = Number.isFinite(parsed) ? parsed : undefined;
    } catch {
        shippedMaxAiCredits = undefined;
    }

    const report = checkConsumerConfig(nodeFs, {
        repoRoot: args.repoRoot,
        files,
        explainPath: args.explainPath,
        workflowPath: args.workflowPath,
        checkerVersion,
        shippedMaxAiCredits,
    });

    process.stdout.write(
        args.json
            ? `${JSON.stringify(report, null, 2)}\n`
            : renderReport(report),
    );

    const errors = report.issues.filter((issue) => issue.severity === "error");
    const warnings = report.issues.filter(
        (issue) => issue.severity === "warning",
    );
    if (errors.length > 0 || (args.strict && warnings.length > 0)) {
        process.exitCode = 1;
    }
};
