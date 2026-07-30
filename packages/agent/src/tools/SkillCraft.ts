// SkillCraft — agent forges its own skills under ~/.ares/skills/.
//
// A skill is just a directory with at minimum SKILL.md describing what it
// does, optionally a handler.js the agent or future sessions can execute.
// The agent uses SkillCraft when it notices a capability gap: instead of
// asking the user, it scaffolds a new skill, registers it, and updates
// CAPABILITIES.md.
//
// This is part of self-extension: the agent grows its own body.

import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import { buildTool } from "@ares/tools";
import { agentPaths, aresAgentHome } from "../paths.js";
import { exists, writeFileAtomic } from "../files.js";
import { emitLifecycle } from "../lifecycle/bus.js";
import { gainForTarget } from "../voice.js";
import { dropCapability, upsertCapability } from "../self/store.js";

// Exported so RunSkill (runtime.ts) can validate `name` before ever touching
// disk — path.join does NOT clamp ".." segments, so an unvalidated name walks
// straight out of skillsDir.
export const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{1,63}$/;

const inputSchema = z
  .object({
    action: z
      .enum(["create", "update", "remove", "list", "read"])
      .describe("create a new skill, update an existing one (SKILL.md or handler), remove one, list all, or read one."),
    name: z
      .string()
      .optional()
      .describe("Skill name. Lowercase, snake_case or kebab-case. Required for create/update/remove/read."),
    description: z
      .string()
      .optional()
      .describe("Short description of what the skill does. Used as SKILL.md frontmatter for create."),
    skill_md: z
      .string()
      .optional()
      .describe("Full SKILL.md body. For create/update."),
    handler_js: z
      .string()
      .optional()
      .describe("Optional handler.js code. For create/update."),
    reason: z
      .string()
      .optional()
      .describe("Why this skill is being crafted. Logged for traceability."),
    provides: z
      .array(z.string())
      .optional()
      .describe(
        "Capabilities this skill SUPPLIES to Ares, so a toggled-on skill can override a built-in. Currently 'tts' (text-to-speech). THE TTS PROVIDER CONTRACT (stable — build any voice engine against it): the handler answers two ops. (1) input {op:'voices'} → {ok:true, voices:[{id,label,gender?,description?}], default?}. (2) input {op:'tts', text, voice, speed} → {ok:true, audio:'<base64>', mime:'<container>'}. `audio` is base64 of a WHOLE encoded audio file in ANY standard container — audio/wav (any sample rate/bit depth), audio/mpeg (mp3), audio/ogg (opus/vorbis), audio/flac, audio/webm. The desktop decodes it with the Web Audio API, so you do NOT resample, do NOT hand-patch WAV headers, and do NOT match a specific rate — just return the engine's native bytes + the right mime. On error return {ok:false, error}. This works identically for a local binary (Piper/Kokoro/Coqui) or an HTTP API (ElevenLabs/OpenAI/Azure) — fetch/spawn, base64 the response bytes, set mime. When enabled, Ares speaks through this instead of the built-in voice. ALSO 'stt' (speech-to-text) — THE STT PROVIDER CONTRACT: the handler answers input {op:'transcribe', audio:'<base64>', mime:'<container>'} → {ok:true, text:'<transcript>'}; audio is a whole recorded clip (typically audio/webm opus from the mic). Works for whisper.cpp, Deepgram, any engine. When enabled, Ares transcribes the mic through it.",
      ),
    surfaces: z
      .array(z.object({ id: z.string(), label: z.string(), icon: z.string().optional(), input: z.unknown().optional(), hint: z.string().optional() }))
      .optional()
      .describe(
        "UI buttons this skill contributes to the active-skills tray. Each button, when clicked, runs THIS skill's handler with its `input` (a surface can only invoke its own skill). e.g. [{id:'brief', label:'Daily brief', icon:'📋', input:{op:'brief'}}].",
      ),
  })
  .strict();

export interface SkillCraftOutput {
  action: string;
  name?: string;
  skillDir?: string;
  files?: string[];
  list?: Array<{ name: string; description: string }>;
  skillMd?: string;
  handlerJs?: string | null;
}

export const SkillCraftTool = buildTool({
  name: "SkillCraft",
  description:
    "Forge your own skills under ~/.ares/skills/. When you notice a capability gap — something you'll need to do that you don't have a clean path for yet — scaffold a skill instead of asking. A skill is just SKILL.md (description, usage, examples) plus optional handler.js. `create` scaffolds a contract-correct starter handler.js for you (ESM default export `async (input, ctx) => result`, tolerant input parsing) — fill it in rather than re-deriving the shape; `import` and `require` both work, and `input` is whatever JSON you pass to RunSkill. After crafting, append the skill name to CAPABILITIES.md via SelfEvolve. You can also update / remove / list / read your own skills. This is part of your self-extension: you grow your own body. " +
    "HARD RULES for skills that spawn OS processes/windows: (1) any window/app the skill opens (Edge --app, Start-Process, etc.) MUST be tracked (record the PID) and closed by the skill's stop/cleanup action — a fire-and-forget window orphans a dead grey rectangle on the user's screen when its backing server dies; (2) any local server the skill starts must have a stop action that ALSO closes windows pointing at it; (3) web UIs a skill serves must render a visible error state when their backend is unreachable, never a blank page.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => `SkillCraft ${i.action}${i.name ? ` ${i.name}` : ""}`,

  async call(input, _ctx): Promise<{ output: SkillCraftOutput; touchedFiles?: string[]; display: string }> {
    const home = aresAgentHome(process.env.ARES_HOME);
    const paths = agentPaths(home);
    await fs.mkdir(paths.skillsDir, { recursive: true });

    if (input.action === "list") {
      const entries = await listSkills(paths.skillsDir);
      return {
        output: { action: "list", list: entries },
        display: `${entries.length} skill(s) on file`,
      };
    }

    if (!input.name) throw new Error(`SkillCraft.${input.action} requires name`);
    if (!SKILL_NAME.test(input.name)) throw new Error(`SkillCraft: invalid name '${input.name}'. Use lowercase letters, digits, _ or -.`);
    const skillDir = path.join(paths.skillsDir, input.name);
    const skillMdPath = path.join(skillDir, "SKILL.md");
    const handlerPath = path.join(skillDir, "handler.js");

    if (input.action === "remove") {
      await fs.rm(skillDir, { recursive: true, force: true });
      try {
        await dropCapability(home, `skill/${input.name}`);
      } catch {
        // self-model is best-effort
      }
      const gain = gainForTarget("SKILL", -1, "removed");
      emitLifecycle({ type: "skill_crafted", name: input.name, action: "removed", gain });
      return {
        output: { action: "remove", name: input.name, skillDir },
        display: `-1 SKILL — removed ${input.name}`,
      };
    }

    if (input.action === "read") {
      if (!(await exists(skillMdPath))) throw new Error(`SkillCraft.read: skill '${input.name}' has no SKILL.md`);
      const skillMd = await fs.readFile(skillMdPath, "utf8");
      let handlerJs: string | null = null;
      if (await exists(handlerPath)) handlerJs = await fs.readFile(handlerPath, "utf8");
      return {
        output: { action: "read", name: input.name, skillDir, skillMd, handlerJs },
        display: `read skill ${input.name}`,
      };
    }

    // create / update
    const exists0 = await exists(skillMdPath);
    if (input.action === "create" && exists0) {
      throw new Error(`SkillCraft.create: skill '${input.name}' already exists. Use update instead.`);
    }
    if (input.action === "update" && !exists0) {
      throw new Error(`SkillCraft.update: skill '${input.name}' does not exist. Use create instead.`);
    }

    await fs.mkdir(skillDir, { recursive: true });
    const skillMdBody = input.skill_md ?? defaultSkillMd(input.name, input.description ?? "", input.provides, input.surfaces);
    await writeFileAtomic(skillMdPath, ensureTrailingNewline(skillMdBody));
    const touched: string[] = [skillMdPath];
    // On create, scaffold a contract-correct starter handler when none is given —
    // ESM default export, tolerant input parsing, no require/input-shape surprises —
    // so a new skill is runnable-ready instead of the model re-deriving (and tripping
    // on) the contract every time. Update only writes a handler when one is given.
    const handlerBody = input.handler_js ?? (input.action === "create" ? defaultHandlerJs(input.name) : undefined);
    if (handlerBody !== undefined) {
      await writeFileAtomic(handlerPath, ensureTrailingNewline(handlerBody));
      touched.push(handlerPath);
    }

    // Auto-log to capabilities ledger so the agent's body of work is visible.
    await appendCapability(paths.capabilities, input.name, input.description ?? "(no description)", input.action);

    // Register the skill as a node in the machine-readable self-model so the
    // growth engine can track and reason over it. Best-effort.
    try {
      await upsertCapability(home, {
        id: `skill/${input.name}`,
        kind: "skill",
        name: input.name,
        status: "have",
        provenance: "SkillCraft",
        description: input.description,
        tags: handlerBody !== undefined ? ["runnable"] : undefined,
      });
    } catch {
      // self-model is best-effort
    }

    const gain = gainForTarget("SKILL", 1, input.action);
    const lifecycleAction = input.action === "create" ? "created" : "updated";
    emitLifecycle({ type: "skill_crafted", name: input.name, action: lifecycleAction, gain });

    return {
      output: { action: input.action, name: input.name, skillDir, files: touched },
      touchedFiles: touched,
      display: `+1 SKILL — ${input.action} ${input.name}`,
    };
  },
});

async function listSkills(dir: string): Promise<Array<{ name: string; description: string }>> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: Array<{ name: string; description: string }> = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const md = path.join(dir, e.name, "SKILL.md");
      let desc = "(no SKILL.md)";
      try {
        const text = await fs.readFile(md, "utf8");
        const m = text.match(/^description:\s*(.+)$/m);
        if (m) desc = m[1].trim();
        else {
          const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0 && !l.startsWith("#"));
          if (firstLine) desc = firstLine.trim().slice(0, 200);
        }
      } catch {
        // SKILL.md missing or unreadable — keep default
      }
      out.push({ name: e.name, description: desc });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function defaultSkillMd(
  name: string,
  description: string,
  provides?: string[],
  surfaces?: Array<{ id: string; label: string; icon?: string; input?: unknown; hint?: string }>,
): string {
  const providesLine = provides && provides.length ? `\nprovides: ${provides.join(", ")}` : "";
  // surfaces MUST be a single JSON line — the frontmatter reader is line-based.
  const surfacesLine = surfaces && surfaces.length ? `\nsurfaces: ${JSON.stringify(surfaces)}` : "";
  return `---
name: ${name}
description: ${description}${providesLine}${surfacesLine}
---

# ${name}

## What it does

${description || "(describe the capability this skill provides)"}

## When to use

(describe triggers)

## How it works

(describe the implementation: shell commands, handler.js function, package
dependencies, etc.)

## Examples

\`\`\`
(usage examples)
\`\`\`
`;
}

/**
 * A correct, runnable starter handler.js. Scaffolded on create when the model
 * doesn't supply one — it encodes the execution contract (ESM default export,
 * `(input, ctx)`, tolerant input, JSON-serializable return) so first-run skills
 * stop tripping on the two things that actually bit: `require` in ESM scope and
 * an unexpected input shape. (`require` also works at runtime via a compat shim,
 * but `import` is the idiom shown here.)
 */
function defaultHandlerJs(name: string): string {
  return `// handler.js for the "${name}" skill — executed by the RunSkill tool.
//
// CONTRACT (keep this shape):
//   • ES module. Prefer \`import\`; \`require(...)\` also works via a runtime shim.
//   • Export a DEFAULT async function, called as:  handler(input, ctx)
//       input = whatever JSON you pass to RunSkill's \`input\` field — it may be a
//               bare string, an object, or undefined, so parse defensively below.
//       ctx   = { home, name }  (your Ares home dir + this skill's name)
//   • Return any JSON-serializable value — it becomes RunSkill's \`result\`.
//   • Network skills must bind ctx.host + ctx.port (also ARES_SKILL_HOST /
//     ARES_SKILL_PORT and HOST / PORT). Ares leases that loopback port from the
//     OS for this run; never hardcode a service port.
//   • Heavy work (image/video/model calls): pass a generous \`timeout_ms\` to
//     RunSkill (it self-caps on that — a too-small value is the only early abort).

export default async function handler(input, ctx) {
  // Tolerant input: accept a bare string, { prompt }, { text }, or { input }.
  const arg =
    typeof input === "string"
      ? input
      : input?.prompt ?? input?.text ?? input?.input ?? "";

  // TODO: implement the capability. Examples:
  //   import { readFile } from "node:fs/promises";
  //   const res = await fetch("http://127.0.0.1:PORT/do", {
  //     method: "POST", headers: { "content-type": "application/json" },
  //     body: JSON.stringify({ arg }),
  //   });
  //   return await res.json();

  return { ok: true, skill: ctx?.name ?? "${name}", received: arg, note: "handler not implemented yet" };
}
`;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : text + "\n";
}

async function appendCapability(file: string, name: string, description: string, action: string): Promise<void> {
  if (!(await exists(file))) return; // CAPABILITIES.md not bootstrapped yet — silent skip.
  const line = `- ${new Date().toISOString().slice(0, 10)} — skill/${name} (${action}): ${description}\n`;
  await fs.appendFile(file, line, "utf8");
}
