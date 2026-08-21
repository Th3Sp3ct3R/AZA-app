export type SessionKernelErrorCode =
  | "KERNEL_CLOSED"
  | "SESSION_NOT_FOUND"
  | "INPUT_NOT_FOUND"
  | "MESSAGE_NOT_FOUND"
  | "TOOL_RUN_NOT_FOUND"
  | "PLAN_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "LEASE_HELD"
  | "STALE_GENERATION"
  | "INVALID_STATE_TRANSITION"
  | "REVISION_CONFLICT"
  | "PLAN_CONFLICT"
  | "INVALID_ARGUMENT";

export class SessionKernelError extends Error {
  constructor(
    readonly code: SessionKernelErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class SessionNotFoundError extends SessionKernelError {
  constructor(sessionId: string) {
    super("SESSION_NOT_FOUND", `Session does not exist: ${sessionId}`, { sessionId });
  }
}

export class IdempotencyConflictError extends SessionKernelError {
  constructor(sessionId: string, key: string) {
    super(
      "IDEMPOTENCY_CONFLICT",
      `Idempotency key ${JSON.stringify(key)} was already used with different input`,
      { sessionId, idempotencyKey: key },
    );
  }
}

export class LeaseHeldError extends SessionKernelError {
  constructor(sessionId: string, ownerId: string, expiresAtMs: number) {
    super("LEASE_HELD", `Session ${sessionId} is already leased by ${ownerId}`, {
      sessionId,
      ownerId,
      expiresAtMs,
    });
  }
}

export class StaleGenerationError extends SessionKernelError {
  constructor(sessionId: string, generation: number, reason: string) {
    super("STALE_GENERATION", `Runner generation ${generation} for ${sessionId} is stale: ${reason}`, {
      sessionId,
      generation,
      reason,
    });
  }
}

export class InvalidStateTransitionError extends SessionKernelError {
  constructor(entity: string, id: string, from: string, to: string) {
    super("INVALID_STATE_TRANSITION", `Cannot transition ${entity} ${id} from ${from} to ${to}`, {
      entity,
      id,
      from,
      to,
    });
  }
}

export class RevisionConflictError extends SessionKernelError {
  constructor(entity: string, id: string, expected: number, actual: number) {
    super("REVISION_CONFLICT", `${entity} ${id} revision changed (expected ${expected}, actual ${actual})`, {
      entity,
      id,
      expected,
      actual,
    });
  }
}

export class PlanConflictError extends SessionKernelError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super("PLAN_CONFLICT", message, details);
  }
}
