export class CommandVerifier {
    name;
    processTool;
    check;
    evidenceMode;
    constructor(name, processTool, check, evidenceMode = "full") {
        this.name = name;
        this.processTool = processTool;
        this.check = check;
        this.evidenceMode = evidenceMode;
    }
    async verify(_candidate, task) {
        const controller = new AbortController();
        const context = { task, step: 0, signal: controller.signal };
        const input = {
            command: this.check.command,
            args: [...this.check.args],
        };
        if (this.check.cwd !== undefined)
            input.cwd = this.check.cwd;
        const result = await this.processTool.execute(input, context);
        const evidence = this.evidenceMode === "full"
            ? result.output
            : summarizeEvidence(result.output, result.ok);
        return { verifier: this.name, passed: result.ok, evidence };
    }
}
function summarizeEvidence(output, passed) {
    const exitCode = output !== null && !Array.isArray(output) && typeof output === "object"
        && typeof output.exitCode === "number"
        ? output.exitCode
        : null;
    return {
        passed,
        exitCode,
        message: passed
            ? "Behavioral grader passed."
            : "Behavioral grader failed. Re-read the task contract and test the implementation without inspecting grader internals.",
    };
}
