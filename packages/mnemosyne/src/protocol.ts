// Mnemosyne wire protocol v1 — type-only, zero runtime deps (same doctrine as
// @ares/garrison's protocol: the frame shapes ARE the API; clients import types
// straight from here).
//
// Transport: WebSocket on 127.0.0.1 (loopback is the wall), plus HTTP
// GET /health on the same port. First client frame MUST be hello with the
// token from <home>/mnemosyne/token.
//
// Correlation: any client frame may carry `req`; the reply echoes it as `re`.

import type { MemoryKind, MemoryNode, RecallResult } from "@ares/mind";
import type { Binding, BindingClass, BindingSource } from "./bindings.js";
import type { CompiledGuard, GuardVerdict } from "./guards.js";
import type { AttestOutcome, ComplianceReport } from "./attest.js";

export const PROTO_VERSION = 1;
export const DEFAULT_MNEMOSYNE_PORT = 7433;

export type MnemosyneClientFrame =
  | { type: "hello"; token: string; client: string; proto: number; req?: string }
  | { type: "remember"; kind: MemoryKind; content: string; tags?: string[]; source?: string; scope?: string; req?: string }
  | { type: "recall"; cue: string; limit?: number; scope?: string; reinforce?: boolean; req?: string }
  | { type: "bindings.list"; req?: string }
  | { type: "bindings.add"; class: BindingClass; text: string; source?: BindingSource; req?: string }
  | { type: "bindings.retire"; id: string; req?: string }
  | { type: "bindings.packet"; req?: string }
  | { type: "attest"; turnId: string; outcomes: Array<{ bindingId: string; outcome: AttestOutcome; note?: string }>; req?: string }
  | { type: "guards.eval"; action: string; req?: string }
  | { type: "compliance"; req?: string }
  | { type: "ping"; req?: string };

export type MnemosyneServerFrame =
  | { type: "welcome"; proto: number; bindings: number; memories: number }
  | { type: "ok"; re?: string }
  | { type: "error"; message: string; re?: string }
  | { type: "remembered"; node: MemoryNode; re?: string }
  | { type: "recalled"; items: RecallResult[]; re?: string }
  | { type: "bindings"; list: Binding[]; re?: string }
  | { type: "binding.added"; binding: Binding; re?: string }
  | {
      type: "bindings.packet";
      /** Correlates the packet with the attest that reports on it. */
      packetId: string;
      /** The always-on set (active laws + pacts), for prompt injection. */
      bindings: Binding[];
      /** Every compiled guard from active bindings, for mechanical checks. */
      guards: CompiledGuard[];
      /** Ready-to-inject prompt block (same voice as lawsPromptBlock). */
      promptBlock: string;
      re?: string;
    }
  | { type: "guards.verdict"; verdicts: GuardVerdict[]; re?: string }
  | { type: "compliance"; report: ComplianceReport; re?: string }
  | { type: "pong"; re?: string };
