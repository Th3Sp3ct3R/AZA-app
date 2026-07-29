import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  completeBootstrap,
  ensureAgentScaffold,
  loadAgentSystemContext,
  workspaceToolsPath,
} from "../packages/agent/dist/index.js";

async function makeTmp(prefix = "ares-v4-bootstrap-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("V4 V1: ensureAgentScaffold creates bootstrap and workspace TOOLS.md without identity", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("ares-v4-workspace-");
  await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { build: "tsc", verify: "tsc --noEmit" } }), "utf8");
  await fs.writeFile(path.join(workspace, "pnpm-lock.yaml"), "", "utf8");

  const state = await ensureAgentScaffold({ home, workspace });

  assert.equal(state.required, true);
  assert.match(await fs.readFile(path.join(home, "BOOTSTRAP.md"), "utf8"), /I just came online/);
  assert.match(await fs.readFile(workspaceToolsPath(workspace), "utf8"), /pnpm verify/);
  assert.match(await fs.readFile(path.join(home, "skills", "browser-x", "SKILL.md"), "utf8"), /verify the posted text/);
  assert.match(await fs.readFile(path.join(home, "skills", "browser-discord", "SKILL.md"), "utf8"), /closed DM/);
});

test("V4 V1: completeBootstrap writes identity files atomically and deletes BOOTSTRAP.md", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("ares-v4-workspace-");
  await ensureAgentScaffold({ home, workspace });

  const state = await completeBootstrap(
    {
      userName: "Clout",
      userTimezone: "America/New_York",
      languages: "TypeScript",
      style: "direct",
      conventions: "pnpm, verify",
      agentName: "Ares",
      creature: "coding daemon",
      vibe: "direct",
      emoji: "*",
      bornAt: new Date("2026-05-28T00:00:00.000Z"),
    },
    { home, workspace },
  );

  assert.equal(state.required, false);
  await assert.rejects(fs.stat(path.join(home, "BOOTSTRAP.md")), /ENOENT/);
  assert.match(await fs.readFile(path.join(home, "IDENTITY.md"), "utf8"), /Name: Ares/);
  assert.match(await fs.readFile(path.join(home, "SOUL.md"), "utf8"), /Skip filler words/);
  assert.match(await fs.readFile(path.join(home, "USER.md"), "utf8"), /Clout/);
});

test("V4 V1: agent context loads identity-first mind files without core importing agent", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("ares-v4-workspace-");
  await completeBootstrap(
    {
      userName: "Clout",
      agentName: "Ares",
      creature: "coding daemon",
      vibe: "careful",
      emoji: "*",
    },
    { home, workspace },
  );

  const context = await loadAgentSystemContext({ home, workspace, includeMemory: true });
  assert.equal(context.bootstrapRequired, false);
  assert.deepEqual(context.blocks.slice(0, 3).map((block) => block.label), ["identity", "soul", "user"]);
  assert.match(context.systemText, /Loaded identity/);
});

test("V4 V1: agent context bounds raw and curated memory blocks", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("ares-v4-workspace-");
  await completeBootstrap(
    {
      userName: "Clout",
      agentName: "Ares",
      creature: "coding daemon",
      vibe: "careful",
      emoji: "*",
    },
    { home, workspace },
  );
  await fs.mkdir(path.join(home, "memory"), { recursive: true });
  await fs.writeFile(path.join(home, "MEMORY.md"), `# Memory\n\n${"m".repeat(80_000)}`, "utf8");
  await fs.writeFile(path.join(home, "memory", "2026-06-02.md"), `# raw\n\n${"t".repeat(80_000)}`, "utf8");
  await fs.writeFile(path.join(home, "memory", "2026-06-01.md"), `# raw\n\n${"y".repeat(80_000)}`, "utf8");

  const context = await loadAgentSystemContext({
    home,
    workspace,
    includeMemory: true,
    today: new Date("2026-06-02T12:00:00.000Z"),
  });

  assert.ok(context.systemText.length < 60_000, `agent context too large: ${context.systemText.length}`);
  assert.ok(context.blocks.find((block) => block.label === "curated memory")?.text.length < 10_100);
  assert.ok(context.blocks.find((block) => block.label === "today raw memory")?.text.length < 2_100);
  assert.ok(context.blocks.find((block) => block.label === "yesterday raw memory")?.text.length < 1_300);
});
