// System-prompt composition.
//
//   persona (configurable)  →  craft core (shared)  →  provider overlay  →  surfaces
//
// Before this split the whole thing was one 33,819-char string — larger than
// opencode's biggest per-model prompt by more than 2×, and 4× their Anthropic
// one — with six sections restating the same doctrine and one 4,660-char block
// paraphrasing tool descriptions the model already receives. Nothing here is
// softened; it is de-duplicated, and the parts that vary by owner (voice) or by
// model (failure mode) now live where they can actually vary.

import { craftCore } from "./craft.js";
import { renderPersona, type PersonaConfig } from "./persona.js";
import { providerOverlay, type ProviderFamily } from "./providerOverlay.js";

export { renderPersona, type PersonaConfig, type PersonaStyle } from "./persona.js";
export { providerOverlay, type ProviderFamily } from "./providerOverlay.js";
export { craftCore } from "./craft.js";

export interface PromptSurfaces {
  /** Tool-specific operational doctrine that is NOT in the tool schemas. */
  tools: string;
  /** Workflow surfaces: Operator, deep research, plan mode, capabilities. */
  workflows: string;
  /** Reach, hard rules, environment block. */
  environment: string;
}

export interface ComposePromptOptions {
  persona?: PersonaConfig;
  providerFamily?: ProviderFamily;
  model?: string;
  surfaces: PromptSurfaces;
  /** The owner's LAWS block (lawsPromptBlock). ALWAYS-ON by design — it rides
   *  the system prompt itself, after the doctrine it outranks, and is never
   *  part of any budgeted context. Empty string when no laws exist. */
  laws?: string;
}

/** Join non-empty blocks with exactly one blank line between them. */
function join(blocks: Array<string | undefined>): string {
  return blocks.map((b) => b?.trim()).filter((b): b is string => Boolean(b)).join("\n\n");
}

export function composeSystemPrompt(opts: ComposePromptOptions): string {
  return join([
    renderPersona(opts.persona),
    craftCore(),
    providerOverlay(opts.providerFamily, opts.model),
    // Laws sit AFTER the doctrine they outrank — recency reinforces the
    // precedence the block itself states — and BEFORE the surfaces, so tool
    // doctrine and environment can still reference them.
    opts.laws,
    opts.surfaces.tools,
    opts.surfaces.workflows,
    opts.surfaces.environment,
  ]);
}
