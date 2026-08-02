// Persona adoption, daemon-side.
//
// The Persona tool validates and echoes; this is where a persona actually gets
// worn. The split exists because a tool has no handle on the live Session, and
// because applying the swap from the event stream means it lands on the NEXT
// turn — the turn that called the tool finishes with the belt and prompt it
// started with, which is what keeps a mid-turn adopt from being a surprise.
//
// Everything here is best-effort: a persona that fails to load must never take
// a turn down with it.

import { bestPersonaFor, listPersonas, readPersona, type PersonaDef } from "@ares/agent";
import type { LiveSession } from "../sessionFactory.js";

/** What the desktop needs to render a chip or a gallery card. */
export interface PersonaWire {
  name: string;
  label: string;
  description: string;
  /** The persona prompt itself. Wired so HELM can load one back into the
   *  composer for editing — without it, "Edit" could only ever offer the
   *  metadata and would silently blank the method on save. */
  body: string;
  greeting: string;
  glyph: string;
  tone: string;
  autonomy: string;
  triggers: string[];
  tools: string[];
  source: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  file: string;
  modifiedAt?: number;
}

export function personaToWire(p: PersonaDef): PersonaWire {
  return {
    name: p.name,
    label: p.label,
    description: p.description,
    body: p.body,
    greeting: p.greeting,
    glyph: p.glyph,
    tone: p.tone,
    autonomy: p.autonomy,
    triggers: p.triggers,
    tools: p.tools,
    source: p.source,
    model: p.model,
    effort: p.effort,
    maxTurns: p.maxTurns,
    file: p.file,
    modifiedAt: p.modifiedAt,
  };
}

type Emit = (payload: Record<string, unknown>) => void;

/**
 * Apply a Persona tool result to the live session.
 *
 * Only `adopt` and `release` do anything here — create/remove/list/read already
 * did their work inside the tool. Emits `persona_changed` so the desktop can
 * swap its chip without polling.
 */
export function applyPersonaToolResult(live: LiveSession, output: unknown, emit: Emit): void {
  if (!output || typeof output !== "object") return;
  const result = output as { action?: string; ok?: boolean; persona?: PersonaDef };
  if (result.ok === false) return;

  if (result.action === "adopt" && result.persona) {
    live.adoptPersona(result.persona);
    emit({ type: "persona_changed", active: personaToWire(result.persona), origin: "agent" });
    return;
  }
  if (result.action === "release") {
    live.adoptPersona(null);
    emit({ type: "persona_changed", active: null, origin: "agent" });
  }
}

/**
 * Offer a persona for the message the owner just sent.
 *
 * Deliberately does NOT adopt on its own: it emits a `persona_suggested` event
 * and lets the surface decide. `auto` personas are announced-and-adopted by the
 * caller; `suggest` ones become a chip the owner taps. Nothing here ever
 * changes behaviour silently — a keyword-triggered switch the owner can't see
 * is the kind of bug that hides for months.
 *
 * Returns the persona to adopt (autonomy "auto" only), or null.
 */
export async function personaForMessage(
  live: LiveSession,
  message: string,
  emit: Emit,
): Promise<PersonaDef | null> {
  // Already wearing one? Leave it alone. Re-matching every turn would make a
  // persona flip mid-conversation on an incidental keyword.
  if (live.activePersona()) return null;
  const roster = await listPersonas(live.context.home).catch(() => []);
  if (roster.length === 0) return null;
  const match = bestPersonaFor(message, roster);
  if (!match) return null;

  if (match.persona.autonomy === "auto") {
    live.adoptPersona(match.persona);
    emit({
      type: "persona_changed",
      active: personaToWire(match.persona),
      origin: "auto",
      matched: match.hits,
    });
    return match.persona;
  }
  emit({
    type: "persona_suggested",
    persona: personaToWire(match.persona),
    matched: match.hits,
  });
  return null;
}

/** Resolve + adopt by name, for the desktop's explicit adopt button. */
export async function adoptPersonaByName(
  live: LiveSession,
  name: string | undefined,
): Promise<{ ok: boolean; active: PersonaWire | null; error?: string }> {
  if (!name) {
    live.adoptPersona(null);
    return { ok: true, active: null };
  }
  const persona = await readPersona(name, live.context.home).catch(() => null);
  if (!persona) return { ok: false, active: null, error: `no persona named "${name}"` };
  live.adoptPersona(persona);
  return { ok: true, active: personaToWire(persona) };
}
