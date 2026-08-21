// Persona — Ares manages its own roster, and wears one when it helps.
//
// A persona is a definition on disk (see roster.ts). This tool is how Ares
// reads that roster, writes new members into it, and adopts or drops one for
// the live conversation.
//
// Adoption is a UI-and-prompt concern, not a filesystem one, so the split
// mirrors SetUiEffect: `create`/`remove` really do touch disk, while
// `adopt`/`release` validate and echo — the daemon watches the event stream,
// swaps the persona layer for the session, and the desktop renders the chip.
// Keeping adoption declarative means the same call works identically whether
// the owner is on the desktop, the TUI, or Telegram.
//
// Two invariants worth defending in review:
//   1. Adoption never narrows the live tool belt. A persona's `tools` list
//      applies when it is DELEGATED to as a subagent; silently removing the
//      owner's tools mid-conversation would be a trap.
//   2. A persona layers above the sealed core. It shifts expertise and voice
//      and can never relax verification — enforced in composeAgentSystemPrompt,
//      documented here so nobody "fixes" it by moving the layer down.

import { z } from "zod";
import { buildTool } from "@ares/tools";
import {
  deletePersona,
  listPersonas,
  readPersona,
  writePersona,
  type PersonaDef,
} from "../roster.js";
import { emitLifecycle } from "../lifecycle/bus.js";

const inputSchema = z
  .object({
    action: z
      .enum(["list", "read", "adopt", "release", "create", "remove"])
      .describe(
        "list every persona on the roster; read one in full; adopt one for this conversation; release the active one; create (or overwrite) a persona on disk; remove a disk persona.",
      ),
    name: z
      .string()
      .optional()
      .describe("Persona name/slug. Required for read/adopt/create/remove."),
    label: z.string().optional().describe("Display name for create (e.g. 'Vitruvius'). Defaults to a title-cased name."),
    description: z
      .string()
      .optional()
      .describe("One line for create: what this persona is expert at. Shown on its gallery card."),
    body: z
      .string()
      .optional()
      .describe(
        "For create: the persona itself — its method, standards, and voice, in markdown. This is the substance; write it as instructions to the persona ('You are working as X. Method: …'). Required for create.",
      ),
    greeting: z
      .string()
      .optional()
      .describe("For create: the persona's first words on adoption. One or two sentences, in its own voice."),
    triggers: z
      .array(z.string())
      .optional()
      .describe(
        "For create: lowercase phrases in the owner's message that suggest this persona ('research', 'look into', 'security'). Prefer a few intentional phrases over many generic words — a trigger like 'fix' fires constantly and makes adoption feel random.",
      ),
    tools: z
      .array(z.string())
      .optional()
      .describe(
        "For create: tool names this persona is limited to WHEN DELEGATED TO as a subagent. Omit or leave empty to inherit the full belt. This never narrows the live session's tools on adoption.",
      ),
    glyph: z
      .string()
      .optional()
      .describe("For create: medallion sigil name — one of helm, forge, shield, search, scroll, sessions, spark, vault."),
    tone: z.enum(["ember", "mint", "ivory"]).optional().describe("For create: card accent. ember = action/build, mint = analysis/ready, ivory = neutral/writing."),
    autonomy: z
      .enum(["auto", "suggest", "manual"])
      .optional()
      .describe(
        "For create: how eagerly it takes the wheel. auto = adopts itself on a trigger match and announces it; suggest = offers a chip the owner taps; manual = only explicit adoption or delegation. Default suggest.",
      ),
    model: z.string().optional().describe("For create: preferred model id. ADVISORY only — an owner's pin always wins."),
    effort: z.string().optional().describe("For create: preferred reasoning effort. Clamped to whatever the live model actually supports."),
    maxTurns: z.number().int().positive().optional().describe("For create: iteration ceiling when this persona is delegated to."),
    reason: z.string().optional().describe("Why — surfaced to the owner and logged. Especially worth filling in for adopt."),
  })
  .strict();

export interface PersonaToolOutput {
  action: string;
  ok: boolean;
  /** Present for list. */
  roster?: Array<Pick<PersonaDef, "name" | "label" | "description" | "autonomy" | "source" | "triggers" | "tools">>;
  /** Present for read/create/adopt. */
  persona?: PersonaDef;
  note: string;
}

function summarize(p: PersonaDef) {
  return {
    name: p.name,
    label: p.label,
    description: p.description,
    autonomy: p.autonomy,
    source: p.source,
    triggers: p.triggers,
    tools: p.tools,
  };
}

export const PersonaTool = buildTool({
  name: "Persona",
  description:
    "Read and manage your own roster of expert personas, and wear one when it fits the work. A persona is a definition on disk (~/.ares/roster/<name>/AGENT.md) with an expertise, a method, triggers, and a voice. Two ways to use one: ADOPT it for the live conversation (you keep full context and the full tool belt, and you announce the switch), or DELEGATE to it via the Task tool — every persona is automatically a valid subagent_type. Use `create` when you notice a recurring kind of work that deserves its own specialist; write a real method in `body`, not a vibe. Use `adopt` when the owner's task clearly calls for a specialist you already have, then greet them in that persona's voice. Use `release` the moment the owner asks you to drop it. Adopting never changes who you are or lowers your standards — it narrows focus and colours voice.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => {
    if (i.action === "adopt") return `Adopting persona · ${i.name ?? "?"}`;
    if (i.action === "release") return "Releasing the active persona";
    if (i.action === "create") return `Forging persona · ${i.label || i.name || "?"}`;
    if (i.action === "remove") return `Removing persona · ${i.name ?? "?"}`;
    if (i.action === "read") return `Reading persona · ${i.name ?? "?"}`;
    return "Reading the roster";
  },

  async call(i): Promise<{ output: PersonaToolOutput; display: string }> {
    const needsName = i.action !== "list" && i.action !== "release";
    if (needsName && !i.name?.trim()) {
      return {
        output: { action: i.action, ok: false, note: `${i.action} requires a persona name.` },
        display: `✗ Persona ${i.action} needs a name`,
      };
    }

    if (i.action === "list") {
      const roster = await listPersonas();
      return {
        output: {
          action: "list",
          ok: true,
          roster: roster.map(summarize),
          note:
            roster.length === 0
              ? "The roster is empty."
              : `${roster.length} personas. Each is also a valid subagent_type for the Task tool, so you can delegate to one instead of adopting it.`,
        },
        display: `◈ Roster · ${roster.map((p) => p.label).join(", ") || "empty"}`,
      };
    }

    if (i.action === "read") {
      const persona = await readPersona(i.name!);
      if (!persona) {
        return {
          output: { action: "read", ok: false, note: `No persona named "${i.name}". Call list to see the roster.` },
          display: `✗ No persona "${i.name}"`,
        };
      }
      return {
        output: { action: "read", ok: true, persona, note: "Full definition, including the body that becomes the persona layer." },
        display: `◈ ${persona.label} — ${persona.description}`,
      };
    }

    if (i.action === "adopt") {
      const persona = await readPersona(i.name!);
      if (!persona) {
        const roster = await listPersonas();
        return {
          output: {
            action: "adopt",
            ok: false,
            roster: roster.map(summarize),
            note: `No persona named "${i.name}". Available: ${roster.map((p) => p.name).join(", ") || "none"}. Create one first if this expertise deserves a standing specialist.`,
          },
          display: `✗ No persona "${i.name}"`,
        };
      }
      emitLifecycle({ type: "persona_changed", action: "adopted", name: persona.name });
      return {
        output: {
          action: "adopt",
          ok: true,
          persona,
          note: `Adopted. Your next message should greet the owner in ${persona.label}'s voice — the greeting IS how they learn the switch happened, so do not skip it. You keep this conversation's full context and full tool belt. Drop it with action:"release" the moment they ask.`,
        },
        display: `◈ Wearing ${persona.label} · ${persona.description}`,
      };
    }

    if (i.action === "release") {
      emitLifecycle({ type: "persona_changed", action: "released", name: "" });
      return {
        output: {
          action: "release",
          ok: true,
          note: "Released. You are plain Ares again for the rest of this conversation — say so in a short line rather than switching voice silently.",
        },
        display: "◈ Persona released",
      };
    }

    if (i.action === "create") {
      if (!i.body?.trim()) {
        return {
          output: { action: "create", ok: false, note: "create requires `body` — the body IS the persona. Write its method and standards, not a one-line vibe." },
          display: "✗ Persona needs a body",
        };
      }
      try {
        const persona = await writePersona({
          name: i.name!,
          label: i.label,
          description: i.description,
          body: i.body,
          greeting: i.greeting,
          triggers: i.triggers,
          tools: i.tools,
          glyph: i.glyph,
          tone: i.tone,
          autonomy: i.autonomy,
          model: i.model,
          effort: i.effort,
          maxTurns: i.maxTurns,
        });
        emitLifecycle({ type: "persona_changed", action: "created", name: persona.name });
        return {
          output: {
            action: "create",
            ok: true,
            persona,
            note: `Written to ${persona.file}. It is now on the roster, visible in HELM → Agents, and already a valid subagent_type for delegation. Adopt it separately if you want to wear it now.`,
          },
          display: `◈ Forged ${persona.label} → ${persona.file}`,
        };
      } catch (err) {
        return {
          output: { action: "create", ok: false, note: `Could not write persona: ${String(err instanceof Error ? err.message : err)}` },
          display: "✗ Persona create failed",
        };
      }
    }

    // remove
    const existing = await readPersona(i.name!);
    if (existing?.source === "builtin") {
      return {
        output: {
          action: "remove",
          ok: false,
          persona: existing,
          note: `"${existing.label}" is a built-in and has no file to delete. To change it, use create with the same name — a disk persona shadows the built-in entirely.`,
        },
        display: `✗ ${existing.label} is built in`,
      };
    }
    const removed = await deletePersona(i.name!);
    if (removed) emitLifecycle({ type: "persona_changed", action: "removed", name: i.name! });
    return {
      output: {
        action: "remove",
        ok: removed,
        note: removed
          ? `Removed "${i.name}" from the roster.`
          : `Could not remove "${i.name}" — it may not exist on disk. Call list to check.`,
      },
      display: removed ? `◈ Removed ${i.name}` : `✗ Could not remove ${i.name}`,
    };
  },
});
