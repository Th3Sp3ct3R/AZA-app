// @ares/mnemosyne — the standalone memory server.
//
// Mnemosyne is memory with FORCE. Three mechanisms, one loop:
//   binding classes — law (owner order) / pact (Ares's own word) / doctrine
//     (learned rule), each with a defined precedence and an always-on set;
//   guard compilation — parseable imperatives become machine-checkable guards
//     so enforcement doesn't rest on the model's goodwill;
//   the attestation loop — every turn reports honored/violated per binding,
//     and complianceReport surfaces "recalled but violated" — the exact
//     failure class that motivated this package (2026-08-10).
//
// It is also the single writer over ~/.ares/mind/memory.jsonl: CLI, garrison
// and daemon speak the wire instead of contending behind the advisory lock.
// LAWS.md remains the synchronous read-through mirror for prompt composition.
//
// Boundary: depends on @ares/mind only. Nothing in core/tools imports this.

export { mnemosynePaths, type MnemosynePaths } from "./paths.js";
export { writeFileAtomic } from "./io.js";
export { tokenPath, ensureToken, constantTimeEqual } from "./token.js";

export {
  BINDING_SCHEMA,
  MAX_LAWS,
  MAX_BINDING_CHARS,
  newBindingId,
  normalizeText,
  saveBinding,
  loadBindings,
  addBinding,
  retireBinding,
  alwaysOnBindings,
  activeGuards,
  importLawsFile,
  exportLawsFile,
  type Binding,
  type BindingClass,
  type BindingSource,
  type BindingStats,
  type AddBindingInput,
} from "./bindings.js";

export {
  compileGuard,
  evaluateGuards,
  strongestVerdict,
  type CompiledGuard,
  type GuardEffect,
  type GuardVerdict,
} from "./guards.js";

export {
  recordAttestations,
  loadAttestations,
  complianceReport,
  type AttestOutcome,
  type AttestationRecord,
  type ComplianceEntry,
  type ComplianceReport,
} from "./attest.js";

export {
  PROTO_VERSION,
  DEFAULT_MNEMOSYNE_PORT,
  type MnemosyneClientFrame,
  type MnemosyneServerFrame,
} from "./protocol.js";

export { MnemosyneServer, renderBindingBlock, type MnemosyneServerOptions } from "./server.js";
export { MnemosyneClient, type MnemosyneClientOptions } from "./client.js";
