import { asciiUppercase } from "../deterministicText.js";
const SECRET_NAME = /(api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|secret)/i;
const SECRET_ASSIGNMENT = /(api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|secret)(\s*[=:]\s*)([^\s,;]+)/gi;
const DANGEROUS_CHILD_ENVIRONMENT = new Set([
    "NODE_OPTIONS",
    "NODE_PATH",
    "BASH_ENV",
    "ENV",
    "PROMPT_COMMAND",
    "PYTHONSTARTUP",
    "RUBYOPT",
    "PERL5OPT",
]);
export function sanitizePublicEvent(value, environment = process.env) {
    const redact = createSecretRedactor(environment);
    return {
        type: safeText(value.type, redact, 100) ?? "event",
        agentId: safeText(value.agentId, redact, 100) ?? "main",
        ...(safeInteger(value.sequence) === undefined ? {} : { sequence: safeInteger(value.sequence) }),
        ...(safeInteger(value.turn) === undefined ? {} : { turn: safeInteger(value.turn) }),
        ...(isStatus(value.status) ? { status: value.status } : {}),
        title: safeText(value.title, redact, 300) ?? "Event",
        ...(safeText(value.detail, redact, 2_000) === undefined ? {} : { detail: safeText(value.detail, redact, 2_000) }),
        ...(safeText(value.message, redact, 8_000) === undefined ? {} : { message: safeText(value.message, redact, 8_000) }),
        ...(safeText(value.tool, redact, 200) === undefined ? {} : { tool: safeText(value.tool, redact, 200) }),
        ...(safeText(value.sessionId, redact, 300) === undefined ? {} : { sessionId: safeText(value.sessionId, redact, 300) }),
        ...(safeText(value.sessionRoot, redact, 2_000) === undefined ? {} : { sessionRoot: safeText(value.sessionRoot, redact, 2_000) }),
        ...(safeText(value.workspaceRoot, redact, 2_000) === undefined ? {} : { workspaceRoot: safeText(value.workspaceRoot, redact, 2_000) }),
        ...(safeText(value.journalFile, redact, 2_000) === undefined ? {} : { journalFile: safeText(value.journalFile, redact, 2_000) }),
        ...(safeText(value.scorecardFile, redact, 2_000) === undefined ? {} : { scorecardFile: safeText(value.scorecardFile, redact, 2_000) }),
        ...(typeof value.materialized === "boolean" ? { materialized: value.materialized } : {}),
    };
}
export function createSecretRedactor(environment = process.env) {
    const secrets = Object.entries(environment)
        .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === "string" && value.length >= 8)
        .map(([, value]) => value)
        .sort((left, right) => right.length - left.length);
    return (text) => {
        let redacted = stripProviderDetail(text)
            .replace(SECRET_ASSIGNMENT, "$1$2[REDACTED]")
            .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
            .replace(/\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
            .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED]");
        for (const secret of secrets)
            redacted = redacted.replaceAll(secret, "[REDACTED]");
        return redacted;
    };
}
export function sanitizedChildEnvironment(environment = process.env) {
    const output = {};
    for (const [name, value] of Object.entries(environment)) {
        if (value === undefined)
            continue;
        const normalized = asciiUppercase(name);
        if (SECRET_NAME.test(name) || DANGEROUS_CHILD_ENVIRONMENT.has(normalized))
            continue;
        output[name] = value;
    }
    output.VANGUARD_CHILD_PROCESS = "1";
    return output;
}
function stripProviderDetail(text) {
    return text.replace(/(Inference endpoint returned HTTP\s+\d+):([\s\S]*)/gi, (_match, head, detail) => {
        const compact = detail.replace(/\s+/gu, " ").trim();
        if (compact.length === 0)
            return `${head}: [no provider detail]`;
        return `${head}: ${compact.length <= 240 ? compact : `${compact.slice(0, 239)}…`}`;
    });
}
function safeText(value, redact, max) {
    if (typeof value !== "string")
        return undefined;
    const clean = redact(value).replaceAll("\0", "");
    return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
function safeInteger(value) {
    return Number.isSafeInteger(value) && value !== undefined && value >= 0 ? value : undefined;
}
function isStatus(value) {
    return value === "pending" || value === "passed" || value === "failed" || value === "info";
}
