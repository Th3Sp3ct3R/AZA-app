import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { aresAgentHome } from "../paths.js";
import {
  CAPABILITY_MANIFEST_FILE,
  CapabilityManifestError,
  SKILL_NAME,
  readCapabilityManifest,
  readCapabilityManifestIfPresent,
  type CapabilityManifest,
  type CapabilityScope,
} from "./manifest.js";

export interface SkillRoot {
  scope: CapabilityScope;
  root: string;
}

export interface ResolvedSkill {
  name: string;
  scope: CapabilityScope;
  root: string;
  dir: string;
  skillMdPath: string;
  handlerPath: string;
  manifestPath: string;
  manifest: CapabilityManifest | null;
  disabled: boolean;
}

export interface CapabilityProvider extends ResolvedSkill {
  manifest: CapabilityManifest;
}

export interface CapabilityRegistryError {
  scope: CapabilityScope;
  skill: string;
  file: string;
  error: string;
}

export interface CapabilityRegistrySnapshot {
  roots: SkillRoot[];
  providers: CapabilityProvider[];
  errors: CapabilityRegistryError[];
}

export interface SkillRegistryOptions {
  home?: string;
  workspace?: string;
}

/** Workspace-local providers deliberately precede user-global providers. The
 * storage scope controls discovery/override order only; it does not confine the
 * target directory a provider may receive at invocation time. */
export function skillRoots(options: SkillRegistryOptions = {}): SkillRoot[] {
  const home = aresAgentHome(options.home ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares"));
  const roots: SkillRoot[] = [];
  if (options.workspace) {
    roots.push({ scope: "workspace", root: path.join(path.resolve(options.workspace), ".ares", "skills") });
  }
  roots.push({ scope: "user", root: path.join(home, "skills") });
  return roots;
}

export async function resolveSkill(
  name: string,
  options: SkillRegistryOptions = {},
): Promise<ResolvedSkill | null> {
  if (!SKILL_NAME.test(name)) throw new Error(`skill '${name}' is not a valid skill name`);
  for (const root of skillRoots(options)) {
    const candidate = skillRecord(root, name);
    if (!(await isDirectory(candidate.dir))) continue;
    candidate.manifest = await readCapabilityManifestIfPresent(candidate.dir);
    if (candidate.manifest && candidate.manifest.scope !== root.scope) {
      throw new CapabilityManifestError(
        `manifest scope '${candidate.manifest.scope}' does not match its '${root.scope}' registry location`,
        candidate.manifestPath,
      );
    }
    candidate.disabled = await pathExists(path.join(candidate.dir, ".disabled"));
    return candidate;
  }
  return null;
}

export async function scanCapabilityRegistry(
  options: SkillRegistryOptions = {},
): Promise<CapabilityRegistrySnapshot> {
  const roots = skillRoots(options);
  const providers: CapabilityProvider[] = [];
  const errors: CapabilityRegistryError[] = [];
  const shadowedNames = new Set<string>();
  const shadowedProviderIds = new Set<string>();

  for (const root of roots) {
    const entries = await fs.readdir(root.root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !SKILL_NAME.test(entry.name) || shadowedNames.has(entry.name)) continue;
      const record = skillRecord(root, entry.name);
      if (!(await pathExists(record.manifestPath))) {
        // Resolution is by visible skill name, not by manifest presence. A
        // workspace-local legacy skill must still shadow a same-named global
        // provider; otherwise registry selection and runSkill would disagree
        // about which code actually executes.
        shadowedNames.add(entry.name);
        continue;
      }
      let manifest: CapabilityManifest;
      try {
        manifest = await readCapabilityManifest(record.manifestPath);
        if (manifest.scope !== root.scope) {
          throw new CapabilityManifestError(
            `manifest scope '${manifest.scope}' does not match its '${root.scope}' registry location`,
            record.manifestPath,
          );
        }
      } catch (error) {
        errors.push({
          scope: root.scope,
          skill: entry.name,
          file: record.manifestPath,
          error: error instanceof Error ? error.message : String(error),
        });
        // A broken workspace-local skill still shadows a same-named user skill.
        // Silently falling through would execute a different provider than the
        // owner sees in the project.
        shadowedNames.add(entry.name);
        continue;
      }
      shadowedNames.add(entry.name);
      if (shadowedProviderIds.has(manifest.id)) continue;
      shadowedProviderIds.add(manifest.id);
      providers.push({
        ...record,
        manifest,
        disabled: await pathExists(path.join(record.dir, ".disabled")),
      });
    }
  }

  return { roots, providers, errors };
}

export async function resolveCapabilityProvider(
  query: { id?: string; capability?: string; name?: string },
  options: SkillRegistryOptions = {},
): Promise<CapabilityProvider | null> {
  if (!query.id && !query.capability && !query.name) {
    throw new Error("resolveCapabilityProvider requires id, capability, or name");
  }
  const snapshot = await scanCapabilityRegistry(options);
  return snapshot.providers.find((provider) => {
    if (provider.disabled) return false;
    if (query.name && provider.name !== query.name) return false;
    if (query.id && provider.manifest.id !== query.id) return false;
    if (query.capability && !(query.capability in provider.manifest.provides)) return false;
    return true;
  }) ?? null;
}

function skillRecord(root: SkillRoot, name: string): ResolvedSkill {
  const dir = path.join(root.root, name);
  const relative = path.relative(path.resolve(root.root), path.resolve(dir));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`skill '${name}' resolves outside the skills directory`);
  }
  return {
    name,
    scope: root.scope,
    root: root.root,
    dir,
    skillMdPath: path.join(dir, "SKILL.md"),
    handlerPath: path.join(dir, "handler.js"),
    manifestPath: path.join(dir, CAPABILITY_MANIFEST_FILE),
    manifest: null,
    disabled: false,
  };
}

async function isDirectory(candidate: string): Promise<boolean> {
  return fs.stat(candidate).then((stat) => stat.isDirectory(), () => false);
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true, () => false);
}
