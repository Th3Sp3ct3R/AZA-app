import type { RunOutcome } from "../kernel/run.js";
export type OutcomeClassification = "verified" | "capability_failure" | "infrastructure_error";
export declare function classifyOutcome(outcome: RunOutcome): OutcomeClassification;
