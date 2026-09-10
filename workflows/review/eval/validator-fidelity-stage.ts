import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";

import type {FidelityFixture} from "./claim-fidelity";
import type {Claim} from "../lib/dispatch-contracts";
import type {StagedCase} from "./live-stage";

export const sha256 = (bytes: string | Buffer): string =>
    createHash("sha256").update(bytes).digest("hex");

export type SourceReader = (path: string, commit: string) => Buffer | null;
export type Snapshot = {
    caseId: string;
    reviewedCommit: string;
    baseCommit: string;
    files: {path: string; headHash: string; baseHash: string | null}[];
};

// Definitions and callers cited by the comments but not needed in the small
// deterministic evidence excerpts. Fetch them at the same reviewed commit.
const EXTRA_PATHS: Record<string, string[]> = {
    "webapp-41989-district-query-support": [
        "services/districts/emails/monthly_admin_email_batch.go",
        "services/districts/emails/kad_email_subscriptions.go",
    ],
    "webapp-41896-coaching-batch-support": [
        "services/progress/resolvers/coaching_loader.go",
        "pkg/external/opentelemetry/tracegroup/tracegroup.go",
    ],
    "webapp-42001-phantom-debug-summary": [
        "services/humanities/resolvers/writing_coach_config_test.go",
        "pkg/lib/errors/graphql_presenter.go",
    ],
};

const safePath = (path: string): void => {
    if (
        !/^[A-Za-z0-9_./-]+$/.test(path) ||
        path.startsWith("/") ||
        path.split("/").some((part) => part === ".." || part === "")
    ) {
        throw new Error(`Invalid snapshot path: ${path}`);
    }
};
const put = (path: string, bytes: string | Buffer): void => {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, bytes);
};

/** Host-side only. The validator gets no network tools or github credentials. */
export const githubSource: SourceReader = (path, commit) => {
    safePath(path);
    if (!/^[a-f0-9]{40}$/.test(commit)) {
        throw new Error("Expected a full reviewed or base commit sha");
    }
    try {
        return execFileSync(
            "gh",
            [
                "api",
                `repos/Khan/webapp/contents/${path}?ref=${commit}`,
                "-H",
                "Accept: application/vnd.github.raw+json",
            ],
            {
                maxBuffer: 20 * 1024 * 1024,
                timeout: 30_000,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
    } catch (error) {
        const stderr = String((error as {stderr?: Buffer}).stderr ?? "");
        if (/HTTP 404/.test(stderr)) {
            return null;
        }
        throw new Error(`Source fetch failed for ${commit}/${path}: ${stderr}`);
    }
};

/** Cache full files outside the model's read scope. Never cache the answers there. */
export const prepareSnapshot = (
    fixture: FidelityFixture,
    sourceRoot: string,
    read: SourceReader,
): Snapshot => {
    const {reviewedCommit, evidence} = fixture.provenance;
    const bases = [
        ...new Set(
            evidence.map((e) => e.commit).filter((c) => c !== reviewedCommit),
        ),
    ];
    if (bases.length !== 1) {
        throw new Error("Expected exactly one pinned PR base");
    }
    const baseCommit = bases[0];
    const paths = [
        ...new Set([
            ...evidence
                .filter((e) => e.commit === reviewedCommit)
                .map((e) => e.path),
            ...(EXTRA_PATHS[fixture.corpusCase.id] ?? []),
        ]),
    ].sort();
    const files: Snapshot["files"] = [];
    for (const path of paths) {
        safePath(path);
        const head = read(path, reviewedCommit);
        if (head === null) {
            throw new Error(`Reviewed file missing: ${path}`);
        }
        const base = read(path, baseCommit);
        const headHash = sha256(head);
        const baseHash = base === null ? null : sha256(base);
        for (const reference of evidence.filter((e) => e.path === path)) {
            const actual =
                reference.commit === reviewedCommit ? headHash : baseHash;
            if (actual !== reference.fileSha256) {
                throw new Error(
                    `Pinned source hash mismatch: ${reference.commit}/${path}`,
                );
            }
        }
        put(join(sourceRoot, fixture.corpusCase.id, "head", path), head);
        if (base !== null) {
            put(join(sourceRoot, fixture.corpusCase.id, "base", path), base);
        }
        files.push({path, headHash, baseHash});
    }
    const snapshot = {
        caseId: fixture.corpusCase.id,
        reviewedCommit,
        baseCommit,
        files,
    };
    put(
        join(sourceRoot, fixture.corpusCase.id, "snapshot.json"),
        JSON.stringify(snapshot, null, 2),
    );
    return snapshot;
};

/** Read and verify cached bytes on every replay, including the cached PR base. */
export const readSnapshot = (sourceRoot: string, snapshot: Snapshot) =>
    snapshot.files.map((file) => {
        safePath(file.path);
        const root = join(sourceRoot, snapshot.caseId);
        const head = readFileSync(join(root, "head", file.path));
        const base =
            file.baseHash === null
                ? Buffer.alloc(0)
                : readFileSync(join(root, "base", file.path));
        if (
            sha256(head) !== file.headHash ||
            (file.baseHash !== null && sha256(base) !== file.baseHash)
        ) {
            throw new Error(`Cached source hash mismatch: ${file.path}`);
        }
        return {...file, head, base};
    });

/** Stage only code, diff, minimal PR metadata, and one blinded candidate. */
export const stageValidatorCase = (
    sourceRoot: string,
    snapshot: Snapshot,
    claim: Claim,
    rootDir: string,
): StagedCase => {
    const checkoutDir = join(rootDir, "checkout");
    const contextDir = join(rootDir, "context");
    const diffs: string[] = [];
    mkdirSync(contextDir, {recursive: true});
    for (const file of readSnapshot(sourceRoot, snapshot)) {
        const headPath = join(checkoutDir, file.path);
        put(headPath, file.head);
        // The temporary base lives in context only while diff runs. It does
        // not expose fixture expectations or a second sample to the model.
        const basePath = join(contextDir, "base-input");
        put(basePath, file.base);
        let diff: string;
        try {
            diff = execFileSync(
                "diff",
                [
                    "-u",
                    "--label",
                    file.baseHash === null ? "/dev/null" : `a/${file.path}`,
                    "--label",
                    `b/${file.path}`,
                    basePath,
                    headPath,
                ],
                {encoding: "utf8", maxBuffer: 20 * 1024 * 1024},
            );
        } catch (error) {
            if ((error as {status?: number}).status !== 1) {
                throw error;
            }
            diff = String((error as {stdout?: string}).stdout ?? "");
        }
        if (diff !== "") {
            diffs.push(`diff --git a/${file.path} b/${file.path}\n${diff}`);
        }
    }
    put(join(contextDir, "base-input"), "");
    put(join(contextDir, "pr.diff"), diffs.join("\n"));
    put(join(contextDir, "claims.json"), JSON.stringify([claim], null, 2));
    put(
        join(contextDir, "pr-context.json"),
        JSON.stringify({
            title: "Historical candidate validation",
            description: "",
            author: "unknown",
            baseBranch: "main",
            draft: false,
            headSha: snapshot.reviewedCommit,
            baseSha: snapshot.baseCommit,
        }),
    );
    return {caseId: snapshot.caseId, rootDir, checkoutDir, contextDir};
};
