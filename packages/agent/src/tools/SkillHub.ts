// SkillHub tool — let Ares browse the doingteam skill registry conversationally
// ("check the SkillHub for a Spotify skill" → search → show matches → install
// the one the user picks) and publish skills it (or the user) crafted so others
// can use them. The client + contract live in ../skills/hub.js; this is the
// agent-facing surface.

import { z } from "zod";
import { buildTool } from "@ares/tools";
import { aresAgentHome } from "../paths.js";
import {
  skillHubProbe,
  skillHubList,
  skillHubGet,
  skillHubPublish,
  installHubSkill,
  readLocalSkillFiles,
  type HubSkillMeta,
} from "../skills/hub.js";

const inputSchema = z
  .object({
    action: z
      .enum(["search", "install", "publish"])
      .describe(
        "search: browse/search published skills on the doingteam SkillHub. install: download a skill by id into ~/.ares/skills (then RunSkill it). publish: upload one of YOUR local skills so others can use it (needs a connected Ares account).",
      ),
    query: z.string().optional().describe("Search terms for 'search' (empty = browse popular)."),
    id: z.string().optional().describe("Hub skill id for 'install'."),
    name: z.string().optional().describe("Local skill name for 'publish'."),
    limit: z.number().int().min(1).max(100).optional().describe("Max search results (default 40)."),
  })
  .strict();

export interface SkillHubOutput {
  action: string;
  reachable: boolean;
  skills?: HubSkillMeta[];
  installed?: { name: string; dir: string };
  published?: { ok: boolean; id?: string; error?: string };
  note?: string;
}

export function makeSkillHubTool(opts: { gatewayBase: string; gatewayToken?: string }) {
  const base = opts.gatewayBase;
  return buildTool({
    name: "SkillHub",
    description:
      "Browse, install, and publish skills on the doingteam SkillHub — a shared registry so a good skill written once helps everyone. Use `search` when the user wants a capability you don't have a local skill for yet (check the hub before crafting from scratch); present the matches and let them choose. `install` pulls a skill into ~/.ares/skills (run it with RunSkill). `publish` uploads a local skill (needs a connected Ares account). Degrades gracefully when the hub isn't reachable.",
    safety: "external-state",
    concurrency: "exclusive",
    inputZod: inputSchema,
    activityDescription: (i) =>
      i.action === "search" ? `Searching the SkillHub${i.query ? ` for ${i.query}` : ""}`
      : i.action === "install" ? `Installing ${i.id ?? "a skill"} from the SkillHub`
      : `Publishing ${i.name ?? "a skill"} to the SkillHub`,

    async call(input): Promise<{ output: SkillHubOutput; display: string }> {
      const reachable = await skillHubProbe(base);
      if (!reachable) {
        return {
          output: { action: input.action, reachable: false, note: "The SkillHub isn't reachable yet — the doingteam registry may not be live. Craft the skill locally with SkillCraft instead." },
          display: "SkillHub unreachable",
        };
      }
      const home = aresAgentHome(process.env.ARES_HOME);

      if (input.action === "search") {
        const skills = await skillHubList(base, input.query ?? "", input.limit ?? 40);
        return {
          output: { action: "search", reachable: true, skills },
          display: skills.length ? `${skills.length} skill(s) on the hub${input.query ? ` matching "${input.query}"` : ""}` : "no matching skills on the hub",
        };
      }

      if (input.action === "install") {
        if (!input.id) throw new Error("SkillHub.install requires an id (from search results)");
        const files = await skillHubGet(base, input.id);
        if (!files) throw new Error(`SkillHub: skill '${input.id}' not found`);
        const installed = await installHubSkill(home, files);
        return {
          output: { action: "install", reachable: true, installed },
          display: `installed ${installed.name} → ~/.ares/skills/${installed.name}`,
        };
      }

      // publish
      if (!input.name) throw new Error("SkillHub.publish requires the local skill name");
      const files = await readLocalSkillFiles(home, input.name);
      if (!files) throw new Error(`SkillHub: local skill '${input.name}' not found (craft it with SkillCraft first)`);
      const published = await skillHubPublish(base, opts.gatewayToken ?? "", files);
      if (!published.ok) throw new Error(`SkillHub publish failed: ${published.error ?? "unknown"}`);
      return {
        output: { action: "publish", reachable: true, published },
        display: `published ${input.name} to the SkillHub${published.id ? ` (${published.id})` : ""}`,
      };
    },
  });
}
