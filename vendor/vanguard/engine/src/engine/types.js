export const VANGUARD_PROTOCOL_VERSION = 1;
export const VANGUARD_PROTOCOL_CAPABILITIES = [
    "sessions.create",
    "sessions.resume",
    "sessions.advance",
    "sessions.steer",
    "sessions.cancel",
    "sessions.stopAndWait",
    "sessions.status",
    "events.push",
    "events.replay",
];
export const VANGUARD_IDEMPOTENT_CREATE_CAPABILITY = "sessions.create.idempotent";
export const VANGUARD_WORKER_FENCING_CAPABILITY = "sessions.workerFenced";
export const VANGUARD_EXECUTION_TREE_FENCING_CAPABILITY = "sessions.executionTreeFenced";
export class VanguardEngineError extends Error {
    code;
    retryable;
    details;
    constructor(code, message, retryable = false, details) {
        super(message);
        this.code = code;
        this.retryable = retryable;
        this.details = details;
        this.name = "VanguardEngineError";
    }
}
