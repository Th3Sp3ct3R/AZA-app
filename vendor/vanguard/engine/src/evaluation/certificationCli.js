#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { authorizeExternalEvaluator, createBlindedAssignments, estimateCertificationCost, evaluateCertificate, manifestSha256, validateCertificationLedger, validateCertificationManifest, validateAssignmentArtifacts, } from "./certification.js";
import { CertificationExecutionOrchestrator, DeterministicDryRunAdapter, DeterministicDryRunIsolationVerifier, extractCertificationExecutionProofs, FileCertificationExecutionLedger, validateExecutionLedger, } from "./certificationRunner.js";
export async function runCertificationCli(argv) {
    const command = argv[0];
    const options = parseOptions(argv.slice(1));
    if (command === "validate") {
        const manifest = await readJson(required(options, "manifest"));
        validateCertificationManifest(manifest);
        const holdout = manifest.tasks.filter((task) => task.layer === "holdout");
        return {
            ok: true,
            manifestSha256: manifestSha256(manifest),
            holdoutTasks: holdout.length,
            repositories: new Set(holdout.map((task) => task.repositoryId)).size,
            independentGroups: new Set(holdout.map((task) => task.independenceGroupId)).size,
        };
    }
    if (command === "blind") {
        const manifest = await readJson(required(options, "manifest"));
        const secretName = options.get("secret-env") ?? "VANGUARD_BLINDING_SECRET";
        const secret = process.env[secretName];
        if (secret === undefined)
            throw new Error(`Blinding secret environment variable '${secretName}' is not set.`);
        const bundle = createBlindedAssignments(manifest, secret);
        const publicFile = path.resolve(required(options, "public-out"));
        const privateFile = path.resolve(required(options, "private-out"));
        if (publicFile === privateFile)
            throw new Error("Public and private assignment files must be different.");
        await exclusiveJson(privateFile, bundle.privateArtifact);
        try {
            await exclusiveJson(publicFile, bundle.publicArtifact);
        }
        catch (error) {
            throw error;
        }
        return {
            ok: true,
            manifestSha256: bundle.publicArtifact.manifestSha256,
            assignments: bundle.publicArtifact.assignments.length,
            publicFile,
            privateArtifactWritten: true,
        };
    }
    if (command === "evaluate") {
        const manifest = await readJson(required(options, "manifest"));
        const publicArtifact = await readJson(required(options, "public"));
        const privateArtifact = await readJson(required(options, "private"));
        const ledger = await readJson(required(options, "ledger"));
        const executionStore = new FileCertificationExecutionLedger(required(options, "execution-ledger"));
        const executionLedger = await executionStore.load();
        const authority = authorizeExternalEvaluator(manifest, required(options, "evaluator-id"));
        validateAssignmentArtifacts(manifest, publicArtifact, privateArtifact, authority);
        validateCertificationLedger(manifest, ledger);
        const proofs = extractCertificationExecutionProofs(manifest, executionLedger, publicArtifact, privateArtifact, authority);
        return evaluateCertificate(manifest, publicArtifact, privateArtifact, ledger, proofs, authority);
    }
    if (command === "dry-run") {
        const manifest = await readJson(required(options, "manifest"));
        const publicArtifact = await readJson(required(options, "public"));
        const privateArtifact = await readJson(required(options, "private"));
        const authority = authorizeExternalEvaluator(manifest, required(options, "evaluator-id"));
        const store = new FileCertificationExecutionLedger(required(options, "execution-ledger"));
        const adapter = new DeterministicDryRunAdapter();
        const attestationVerifier = new DeterministicDryRunIsolationVerifier();
        const orchestrator = new CertificationExecutionOrchestrator(manifest, publicArtifact, privateArtifact, authority, adapter, attestationVerifier, store, { maxInfrastructureAttempts: integerOption(options, "max-attempts", 2) });
        const summary = await orchestrator.run();
        return {
            ok: true,
            mode: "dry-run/no-provider",
            providerCalls: 0,
            fakeAdapterCalls: adapter.calls,
            ...summary,
        };
    }
    if (command === "audit-execution") {
        const manifest = await readJson(required(options, "manifest"));
        const publicArtifact = await readJson(required(options, "public"));
        const privateArtifact = await readJson(required(options, "private"));
        const authority = authorizeExternalEvaluator(manifest, required(options, "evaluator-id"));
        validateAssignmentArtifacts(manifest, publicArtifact, privateArtifact, authority);
        const store = new FileCertificationExecutionLedger(required(options, "execution-ledger"));
        const ledger = await store.load();
        validateExecutionLedger(ledger, publicArtifact, privateArtifact);
        return { ok: true, entries: ledger.length, ledgerHead: ledger.at(-1)?.hash ?? "0".repeat(64) };
    }
    if (command === "estimate") {
        const manifest = await readJson(required(options, "manifest"));
        const assumptions = await readJson(required(options, "assumptions"));
        return { ok: true, ...estimateCertificationCost(manifest, assumptions) };
    }
    throw new Error("Usage: certificationCli validate|blind|dry-run|audit-execution|evaluate|estimate --manifest FILE [command options]");
}
function parseOptions(args) {
    const options = new Map();
    for (let index = 0; index < args.length; index += 2) {
        const key = args[index];
        const value = args[index + 1];
        if (key === undefined || !key.startsWith("--") || value === undefined || value.startsWith("--")) {
            throw new Error(`Invalid option near '${key ?? "end of command"}'.`);
        }
        const name = key.slice(2);
        if (options.has(name))
            throw new Error(`Duplicate option '--${name}'.`);
        options.set(name, value);
    }
    return options;
}
function required(options, name) {
    const value = options.get(name);
    if (value === undefined)
        throw new Error(`Missing required option '--${name}'.`);
    return value;
}
function integerOption(options, name, fallback) {
    const value = options.get(name);
    if (value === undefined)
        return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed))
        throw new Error(`Option '--${name}' must be an integer.`);
    return parsed;
}
async function readJson(file) {
    return JSON.parse(await readFile(path.resolve(file), "utf8"));
}
async function exclusiveJson(file, value) {
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/u, "$1"))) {
    runCertificationCli(process.argv.slice(2)).then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`), (error) => {
        process.stderr.write(`Certification command failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
