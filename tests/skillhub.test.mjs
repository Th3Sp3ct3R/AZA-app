// SkillHub client — the doingteam registry contract. The backend isn't live
// yet, so we test the client against a mock fetch (list/get/publish/probe) plus
// a real install into a temp home. Everything degrades gracefully when the hub
// is unreachable so the UI/tool surfaces never dead-end.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  skillHubBase, skillHubProbe, skillHubList, skillHubGet, skillHubPublish,
  installHubSkill, readLocalSkillFiles,
} from "../packages/agent/dist/skills/hub.js";

const BASE = "https://www.doingteam.com";

test("skillHubBase builds the registry root", () => {
  assert.equal(skillHubBase(BASE), "https://www.doingteam.com/api/skillhub");
  assert.equal(skillHubBase("https://x.com/"), "https://x.com/api/skillhub");
});

test("probe: true on 200, false on throw", async () => {
  assert.equal(await skillHubProbe(BASE, async () => new Response("", { status: 200 })), true);
  assert.equal(await skillHubProbe(BASE, async () => { throw new Error("down"); }), false);
});

test("list: parses skills, hits the right URL with query, [] on failure", async () => {
  let seen = "";
  const fetchOk = async (url) => {
    seen = String(url);
    return new Response(JSON.stringify({ skills: [{ id: "a1", name: "spotify_now", description: "now playing" }] }), { status: 200 });
  };
  const skills = await skillHubList(BASE, "spotify", 10, fetchOk);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "spotify_now");
  assert.match(seen, /\/api\/skillhub\/list\?q=spotify&limit=10/);
  assert.deepEqual(await skillHubList(BASE, "x", 10, async () => new Response("", { status: 500 })), []);
});

test("publish: requires a token; refuses invalid names; posts with Bearer", async () => {
  const noToken = await skillHubPublish(BASE, "", { name: "x", skill_md: "..." }, async () => new Response("{}"));
  assert.equal(noToken.ok, false);
  assert.match(noToken.error, /not signed in/);

  const badName = await skillHubPublish(BASE, "tok", { name: "../evil", skill_md: "..." }, async () => new Response("{}"));
  assert.equal(badName.ok, false);

  let auth = "";
  const ok = await skillHubPublish(BASE, "tok_123", { name: "my_skill", skill_md: "---\nname: my_skill\n---\n" }, async (_u, init) => {
    auth = init.headers.authorization;
    return new Response(JSON.stringify({ id: "pub_1" }), { status: 200 });
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.id, "pub_1");
  assert.equal(auth, "Bearer tok_123");
});

test("install: writes files under the skills dir; refuses path traversal; round-trips via readLocal", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ares-hub-"));
  try {
    const files = {
      name: "grabber",
      skill_md: "---\nname: grabber\ndescription: grabs\nprovides: tts\n---\n# grabber\n",
      handler_js: "export default async () => ({ ok: true });",
      surfaces_json: '[{"id":"go","label":"Go"}]',
    };
    const installed = await installHubSkill(home, files);
    assert.equal(installed.name, "grabber");
    const md = await readFile(path.join(home, "skills", "grabber", "SKILL.md"), "utf8");
    assert.match(md, /provides: tts/);
    const handler = await readFile(path.join(home, "skills", "grabber", "handler.js"), "utf8");
    assert.match(handler, /ok: true/);

    // path traversal is refused
    await assert.rejects(() => installHubSkill(home, { ...files, name: "../escape" }));

    // readLocalSkillFiles round-trips what install wrote
    const back = await readLocalSkillFiles(home, "grabber");
    assert.equal(back.name, "grabber");
    assert.match(back.skill_md, /grabber/);
    assert.equal(back.surfaces_json, '[{"id":"go","label":"Go"}]');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
