// Engine-config plumbing shared by the daemon, garrison, and session factory.
// Leaf module (no daemon.ts dependency) so sessionFactory can import it without
// a daemon↔sessionFactory cycle. daemon.ts re-exports applyEngineConfigEnv and
// ManualReminderSource for back-compat (garrisonCmd + compiled dist tests).

/** Coerce the UI's engine-config payload into a clean EngineConfig. */
export function normalizeEngineConfig(raw: unknown): import("../../uiSettings.js").EngineConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, min: number, max: number): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : undefined;
  };
  return {
    maxTurns: num(r.maxTurns, 10, 1000),
    gatherStallRounds: num(r.gatherStallRounds, 2, 50),
    toolResultChars: num(r.toolResultChars, 2000, 200_000),
    operatorAutotick: typeof r.operatorAutotick === "boolean" ? r.operatorAutotick : undefined,
    operatorTickMinutes: num(r.operatorTickMinutes, 1, 720),
    subagentTurnLimit: num(r.subagentTurnLimit, 5, 200),
    computerUseBrowser: typeof r.computerUseBrowser === "boolean" ? r.computerUseBrowser : undefined,
  };
}

/** Apply the env-backed engine knobs immediately (no restart for these). */
export function applyEngineConfigEnv(cfg: import("../../uiSettings.js").EngineConfig): void {
  if (cfg.gatherStallRounds) process.env.ARES_GATHER_STALL_ROUNDS = String(cfg.gatherStallRounds);
  if (cfg.toolResultChars) process.env.ARES_TOOL_RESULT_CHARS = String(cfg.toolResultChars);
  // The operator loop is opt-IN (ARES_OPERATOR_LOOP=1). The UI "autotick" toggle
  // drives it; an explicit false also trips the emergency kill so it's truly off.
  if (cfg.operatorAutotick === false) {
    process.env.ARES_OPERATOR_LOOP = "0";
    process.env.ARES_OPERATOR_AUTOTICK = "0";
  } else if (cfg.operatorAutotick === true) {
    process.env.ARES_OPERATOR_LOOP = "1";
    delete process.env.ARES_OPERATOR_AUTOTICK;
  }
  if (cfg.subagentTurnLimit) process.env.ARES_SUBAGENT_TURN_LIMIT = String(cfg.subagentTurnLimit);
  if (cfg.operatorTickMinutes) process.env.ARES_OPERATOR_TICK_MS = String(cfg.operatorTickMinutes * 60_000);
  // Owner opt-in: desktop control of real browser windows. Explicit false
  // clears it so flipping the toggle off takes effect without a restart.
  if (cfg.computerUseBrowser === true) process.env.ARES_COMPUTERUSE_ALLOW_BROWSER = "1";
  else if (cfg.computerUseBrowser === false) delete process.env.ARES_COMPUTERUSE_ALLOW_BROWSER;
}

export type ManualReminderSource =
  | "undo"
  | "hook"
  | "memory"
  | "instructions"
  | "heartbeat"
  | "dream"
  | "recall"
  | "self-revise";
