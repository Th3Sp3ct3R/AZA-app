export type DreamPhase = "light" | "deep" | "rem";

/**
 * Every evolution-class event carries a `gain` — accurate score delta
 * applied to a named target (SOUL, USER, IDENTITY, MEMORY, CAPTURE/<kind>,
 * SKILL, etc). The UI renders these as floating +N score popups, weirdcore
 * style. No flavor text — the numbers tell the story.
 */
export interface EvolutionGain {
  target: string;
  delta: number;
  kind?: string;
}

export type LifecycleEvent =
  | { type: "session_started"; sessionId: string; workspace: string }
  | { type: "turn_started"; sessionId: string; userMessage: string }
  | { type: "turn_ended"; sessionId: string; status: "completed" | "interrupted" | "failed" }
  | { type: "session_ended"; sessionId: string }
  | { type: "session_before_compact"; sessionId: string }
  | { type: "heartbeat_tick"; reason: string }
  | { type: "dream_phase_started"; phase: DreamPhase }
  | { type: "dream_phase_ended"; phase: DreamPhase; promoted: number; pruned: number; gain?: EvolutionGain }
  | { type: "skill_proposed"; name: string; gain?: EvolutionGain }
  | { type: "bootstrap_complete"; agentName: string; home: string; gain?: EvolutionGain }
  | { type: "self_evolve"; target: string; action: string; bytesBefore: number; bytesAfter: number; gain?: EvolutionGain }
  | { type: "capture_detected"; kinds: string[]; excerpt: string; gain?: EvolutionGain }
  | { type: "recall_surfaced"; count: number; gain?: EvolutionGain }
  | { type: "thought"; kind: string; text: string; phase?: "open" | "beat" | "close"; deliberationId?: string; confidence?: number; gain?: EvolutionGain }
  | { type: "skill_crafted"; name: string; action: "created" | "updated" | "removed"; gain?: EvolutionGain }
  | { type: "skill_ran"; name: string; ok: boolean; durationMs: number; gain?: EvolutionGain }
  | { type: "self_reflected"; directives: number; topKind?: string; gain?: EvolutionGain }
  | { type: "capability_changed"; capability: string; gain?: EvolutionGain }
  | { type: "mission_started"; missionId: string; goal: string; gain?: EvolutionGain }
  | { type: "mission_step_completed"; missionId: string; step: string; remaining: number; gain?: EvolutionGain }
  | { type: "mission_verified"; missionId: string; passed: boolean; iteration: number; gain?: EvolutionGain }
  | { type: "mission_completed"; missionId: string; goal: string; steps: number; gain?: EvolutionGain }
  | { type: "persona_changed"; action: "adopted" | "released" | "created" | "removed"; name: string; gain?: EvolutionGain };

const listeners = new Set<(event: LifecycleEvent) => void>();

export function onLifecycle(fn: (event: LifecycleEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitLifecycle(event: LifecycleEvent): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      // Lifecycle observers cannot break the main turn.
    }
  }
}

