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
import {
  CAPABILITY_MANIFEST_FILE,
  SKILL_NAME,
  canonicalCapabilityManifest,
  capabilityManifestSchema,
  readCapabilityManifest,
  type CapabilityManifest,
  type CapabilityScope,
} from "../skills/manifest.js";
import { resolveSkill, skillRoots } from "../skills/registry.js";

// Exported so RunSkill (runtime.ts) can validate `name` before ever touching
// disk — path.join does NOT clamp ".." segments, so an unvalidated name walks
// straight out of skillsDir.
export { SKILL_NAME };

const inputSchema = z
  .object({
    action: z
      .enum(["create", "update", "remove", "list", "read"])
      .describe("create a new skill, update an existing one (SKILL.md or handler), remove one, list all, or read one."),
    name: z
      .string()
      .optional()
      .describe("Skill name. Lowercase, snake_case or kebab-case. Required for create/update/remove/read."),
    scope: z
      .enum(["user", "workspace"])
      .optional()
      .describe("Where the skill lives. user = ~/.ares/skills (default); workspace = <workspace>/.ares/skills."),
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
    capability_manifest: capabilityManifestSchema
      .optional()
      .describe("Strict capability.json provider contract. Its scope must match the requested skill scope."),
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
  scope?: CapabilityScope;
  skillDir?: string;
  files?: string[];
  list?: Array<{ name: string; description: string; scope: CapabilityScope; manifestId?: string }>;
  skillMd?: string;
  handlerJs?: string | null;
  capabilityManifest?: CapabilityManifest | null;
}

export const SkillCraftTool = buildTool({
  name: "SkillCraft",
  description:
    "Forge project-local skills under <workspace>/.ares/skills or user-global skills under ~/.ares/skills. When you notice a capability gap, build and validate a reusable provider instead of hard-coding one engine into Ares. A skill is SKILL.md plus handler.js; capability providers also carry a strict capability.json contract. `create` without handler_js intentionally creates a failing placeholder, not a working capability. Fill it in, run it, and let a successful contract-valid RunSkill receipt prove readiness. Project-local skills shadow same-named global skills. `import` and `require` both work, and handlers receive the selected workspace/target/session context. " +
    "HARD RULES for skills that spawn OS processes/windows: (1) any window/app the skill opens (Edge --app, Start-Process, etc.) MUST be tracked (record the PID) and closed by the skill's stop/cleanup action — a fire-and-forget window orphans a dead grey rectangle on the user's screen when its backing server dies; (2) any local server the skill starts must have a stop action that ALSO closes windows pointing at it; (3) web UIs a skill serves must render a visible error state when their backend is unreachable, never a blank page.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => `SkillCraft ${i.action}${i.name ? ` ${i.name}` : ""}`,

  async call(input, ctx): Promise<{ output: SkillCraftOutput; touchedFiles?: string[]; display: string }> {
    const home = aresAgentHome(process.env.ARES_HOME);
    const paths = agentPaths(home);

    if (input.action === "list") {
      const roots = skillRoots({ home, workspace: ctx.workspace })
        .filter((root) => !input.scope || root.scope === input.scope);
      const entries = (await Promise.all(roots.map((root) => listSkills(root.root, root.scope)))).flat();
      const seen = new Set<string>();
      const visible = entries.filter((entry) => {
        if (seen.has(entry.name)) return false;
        seen.add(entry.name);
        return true;
      });
      return {
        output: { action: "list", list: visible },
        display: `${visible.length} skill(s) on file`,
      };
    }

    if (!input.name) throw new Error(`SkillCraft.${input.action} requires name`);
    if (!SKILL_NAME.test(input.name)) throw new Error(`SkillCraft: invalid name '${input.name}'. Use lowercase letters, digits, _ or -.`);
    const existing = input.action === "create" || input.scope || input.capability_manifest
      ? null
      : await resolveSkill(input.name, { home, workspace: ctx.workspace });
    const scope: CapabilityScope = input.scope ?? input.capability_manifest?.scope ?? existing?.scope ?? "user";
    if (input.capability_manifest && input.capability_manifest.scope !== scope) {
      throw new Error(
        `SkillCraft: capability_manifest.scope '${input.capability_manifest.scope}' does not match requested scope '${scope}'`,
      );
    }
    const skillsDir = scope === "workspace"
      ? path.join(path.resolve(ctx.workspace), ".ares", "skills")
      : paths.skillsDir;
    await fs.mkdir(skillsDir, { recursive: true });
    const skillDir = path.join(skillsDir, input.name);
    const skillMdPath = path.join(skillDir, "SKILL.md");
    const handlerPath = path.join(skillDir, "handler.js");
    const manifestPath = path.join(skillDir, CAPABILITY_MANIFEST_FILE);

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
        output: { action: "remove", name: input.name, scope, skillDir },
        display: `-1 SKILL — removed ${input.name}`,
      };
    }

    if (input.action === "read") {
      if (!(await exists(skillMdPath))) throw new Error(`SkillCraft.read: skill '${input.name}' has no SKILL.md`);
      const skillMd = await fs.readFile(skillMdPath, "utf8");
      let handlerJs: string | null = null;
      if (await exists(handlerPath)) handlerJs = await fs.readFile(handlerPath, "utf8");
      let capabilityManifest: CapabilityManifest | null = null;
      if (await exists(manifestPath)) {
        capabilityManifest = await readCapabilityManifest(manifestPath);
      }
      return {
        output: { action: "read", name: input.name, scope, skillDir, skillMd, handlerJs, capabilityManifest },
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
    const skillMdBody = input.skill_md ?? defaultSkillMd(input.name, input.description ?? "", scope, input.provides, input.surfaces);
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
    if (input.capability_manifest) {
      await writeFileAtomic(manifestPath, canonicalCapabilityManifest(input.capability_manifest));
      touched.push(manifestPath);
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
        // Authoring is not proof. A successful, contract-valid RunSkill outcome
        // is what promotes this capability to `have`.
        status: "acquiring",
        provenance: "SkillCraft",
        description: input.description,
        tags: input.action === "create" && input.handler_js === undefined
          ? ["placeholder"]
          : handlerBody !== undefined
            ? ["runnable"]
            : undefined,
      });
    } catch {
      // self-model is best-effort
    }

    const gain = gainForTarget("SKILL", 1, input.action);
    const lifecycleAction = input.action === "create" ? "created" : "updated";
    emitLifecycle({ type: "skill_crafted", name: input.name, action: lifecycleAction, gain });

    return {
      output: { action: input.action, name: input.name, scope, skillDir, files: touched },
      touchedFiles: touched,
      display: `+1 SKILL — ${input.action} ${input.name}`,
    };
  },
});

async function listSkills(
  dir: string,
  scope: CapabilityScope,
): Promise<Array<{ name: string; description: string; scope: CapabilityScope; manifestId?: string }>> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: Array<{ name: string; description: string; scope: CapabilityScope; manifestId?: string }> = [];
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
      let manifestId: string | undefined;
      try {
        const manifest = capabilityManifestSchema.parse(
          JSON.parse(await fs.readFile(path.join(dir, e.name, CAPABILITY_MANIFEST_FILE), "utf8")),
        );
        manifestId = manifest.id;
      } catch {
        manifestId = undefined;
      }
      out.push({ name: e.name, description: desc, scope, manifestId });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function defaultSkillMd(
  name: string,
  description: string,
  scope: CapabilityScope,
  provides?: string[],
  surfaces?: Array<{ id: string; label: string; icon?: string; input?: unknown; hint?: string }>,
): string {
  const providesLine = provides && provides.length ? `\nprovides: ${provides.join(", ")}` : "";
  // surfaces MUST be a single JSON line — the frontmatter reader is line-based.
  const surfacesLine = surfaces && surfaces.length ? `\nsurfaces: ${JSON.stringify(surfaces)}` : "";
  return `---
name: ${name}
description: ${description}
scope: ${scope}${providesLine}${surfacesLine}
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
//       ctx   = { home, name, skillDir, workspace, targetRoot, sessionId,
//                 host, port }
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

  return {
    ok: false,
    skill: ctx?.name ?? "${name}",
    received: arg,
    error: "handler not implemented yet",
  };
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
