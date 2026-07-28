// SkillHub — the client for the doingteam skill registry. Ares (and the user)
// can publish a crafted skill and browse/install skills others published, so a
// good skill written once is available to everyone.
//
// This is the CLIENT half. The registry lives on doingteam (the gateway host);
// every call degrades gracefully when it isn't reachable, and the UI/tool gate
// their SkillHub surfaces on `skillHubProbe` so nothing dead-ends before the
// backend is live. Contract (all under `${gatewayBase}/api/skillhub`):
//   GET  /health                      → 200 when the hub is live
//   GET  /list?q=<query>&limit=<n>    → { skills: HubSkillMeta[] }
//   GET  /get/<id>                    → HubSkillFiles
//   POST /publish  (Bearer token)     → { ok, id } | { ok:false, error }

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { aresAgentHome } from "../paths.js";
import { SKILL_NAME } from "../tools/SkillCraft.js";

export interface HubSkillMeta {
  id: string;
  name: string;
  description: string;
  author?: string;
  provides?: string[];
  version?: string;
  downloads?: number;
  updatedAt?: string;
}

export interface HubSkillFiles {
  name: string;
  skill_md: string;
  handler_js?: string;
  surfaces_json?: string;
}

export function skillHubBase(gatewayBase: string): string {
  return `${gatewayBase.replace(/\/+$/, "")}/api/skillhub`;
}

/** Is the hub reachable? Gates the UI/tool surfaces so they stay hidden until
 *  the doingteam backend goes live. Never throws. */
export async function skillHubProbe(gatewayBase: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${skillHubBase(gatewayBase)}/health`, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Browse/search published skills. Returns [] on any failure. */
export async function skillHubList(gatewayBase: string, query = "", limit = 40, fetchImpl: typeof fetch = fetch): Promise<HubSkillMeta[]> {
  try {
    const url = new URL(`${skillHubBase(gatewayBase)}/list`);
    if (query.trim()) url.searchParams.set("q", query.trim());
    url.searchParams.set("limit", String(Math.max(1, Math.min(100, limit))));
    const res = await fetchImpl(url.toString(), { method: "GET" });
    if (!res.ok) return [];
    const data = (await res.json()) as { skills?: HubSkillMeta[] };
    return Array.isArray(data.skills) ? data.skills : [];
  } catch {
    return [];
  }
}

/** Fetch a skill's files by id. Returns null on failure. */
export async function skillHubGet(gatewayBase: string, id: string, fetchImpl: typeof fetch = fetch): Promise<HubSkillFiles | null> {
  try {
    const res = await fetchImpl(`${skillHubBase(gatewayBase)}/get/${encodeURIComponent(id)}`, { method: "GET" });
    if (!res.ok) return null;
    const data = (await res.json()) as HubSkillFiles;
    return data && typeof data.name === "string" && typeof data.skill_md === "string" ? data : null;
  } catch {
    return null;
  }
}

/** Publish a skill's files. Requires the account token (Bearer). */
export async function skillHubPublish(
  gatewayBase: string,
  token: string,
  files: HubSkillFiles,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!token) return { ok: false, error: "not signed in — connect your Ares account to publish" };
  if (!SKILL_NAME.test(files.name)) return { ok: false, error: `invalid skill name '${files.name}'` };
  try {
    const res = await fetchImpl(`${skillHubBase(gatewayBase)}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(files),
    });
    const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string; message?: string };
    if (!res.ok) return { ok: false, error: data.error ?? data.message ?? `publish failed (${res.status})` };
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Write hub-fetched files into ~/.ares/skills/<name>/. Path-traversal-safe. */
export async function installHubSkill(homeArg: string | undefined, files: HubSkillFiles): Promise<{ name: string; dir: string }> {
  if (!SKILL_NAME.test(files.name)) throw new Error(`refusing to install skill with invalid name '${files.name}'`);
  const home = aresAgentHome(homeArg);
  const skillsDir = path.join(home, "skills");
  const dir = path.join(skillsDir, files.name);
  // Defense in depth: the resolved dir MUST stay under skillsDir.
  if (path.relative(skillsDir, dir).startsWith("..")) throw new Error("skill path escapes the skills directory");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), files.skill_md, "utf8");
  if (files.handler_js) await writeFile(path.join(dir, "handler.js"), files.handler_js, "utf8");
  if (files.surfaces_json) await writeFile(path.join(dir, "surfaces.json"), files.surfaces_json, "utf8");
  return { name: files.name, dir };
}

/** Read a local skill's files back out, for publishing it to the hub. */
export async function readLocalSkillFiles(homeArg: string | undefined, name: string): Promise<HubSkillFiles | null> {
  if (!SKILL_NAME.test(name)) return null;
  const dir = path.join(aresAgentHome(homeArg), "skills", name);
  const skill_md = await readFile(path.join(dir, "SKILL.md"), "utf8").catch(() => "");
  if (!skill_md) return null;
  const handler_js = await readFile(path.join(dir, "handler.js"), "utf8").catch(() => undefined);
  const surfaces_json = await readFile(path.join(dir, "surfaces.json"), "utf8").catch(() => undefined);
  return { name, skill_md, handler_js: handler_js || undefined, surfaces_json: surfaces_json || undefined };
}
