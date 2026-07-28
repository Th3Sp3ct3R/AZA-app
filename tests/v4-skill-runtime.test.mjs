// Verifies the skill execution runtime — the line between an agent that writes
// about capabilities and one that runs them:
//   1. A handler.js default export runs and its return value comes back.
//   2. Input is passed through to the handler.
//   3. A throwing handler is captured as ok:false with the error, not a crash.
//   4. A hanging handler is killed by the timeout.
//   5. A skill with no handler.js errors clearly.
//   6. RunSkill tool runs a crafted skill end-to-end and emits skill_ran.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  runSkill,
  RunSkillTool,
  SkillCraftTool,
  onLifecycle,
} from "../packages/agent/dist/index.js";

const ctx = { workspace: process.cwd(), signal: new AbortController().signal };

async function makeHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ares-skillrt-"));
}

async function writeSkill(home, name, handlerJs) {
  const dir = path.join(home, "skills", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: test skill\n---\n`, "utf8");
  if (handlerJs !== undefined) await fs.writeFile(path.join(dir, "handler.js"), handlerJs, "utf8");
}

test("runtime: handler default export runs and returns its result", async () => {
  const home = await makeHome();
  await writeSkill(home, "adder", "export default async (input) => ({ sum: (input?.a ?? 0) + (input?.b ?? 0) });");
  const r = await runSkill({ home, name: "adder", input: { a: 2, b: 3 } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result, { sum: 5 });
  assert.equal(r.timedOut, false);
});

test("runtime: input is passed through to the handler", async () => {
  const home = await makeHome();
  await writeSkill(home, "echo", "export default async (input) => input;");
  const r = await runSkill({ home, name: "echo", input: { hello: "world", n: 42 } });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result, { hello: "world", n: 42 });
});

test("runtime: every skill receives an OS-leased loopback port contract", async () => {
  const home = await makeHome();
  await writeSkill(home, "port-aware", `import { createServer } from "node:net";
export default async (_input, ctx) => {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(ctx.port, ctx.host, resolve); });
  await new Promise((resolve) => server.close(resolve));
  return { host: ctx.host, port: ctx.port, envPort: Number(process.env.ARES_SKILL_PORT), genericPort: Number(process.env.PORT), bound: true };
};`);
  const r = await runSkill({ home, name: "port-aware" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.host, "127.0.0.1");
  assert.ok(Number.isInteger(r.result.port) && r.result.port > 0);
  assert.equal(r.result.envPort, r.result.port);
  assert.equal(r.result.genericPort, r.result.port);
  assert.equal(r.result.bound, true);
});

test("runtime: a throwing handler is captured as ok:false, not a crash", async () => {
  const home = await makeHome();
  await writeSkill(home, "boom", "export default async () => { throw new Error('kaboom'); };");
  const r = await runSkill({ home, name: "boom" });
  assert.equal(r.ok, false);
  assert.match(r.error, /kaboom/);
});

test("runtime: a hanging handler is killed by the timeout", async () => {
  const home = await makeHome();
  await writeSkill(home, "hang", "export default async () => { await new Promise((r) => setTimeout(r, 60000)); };");
  const r = await runSkill({ home, name: "hang", timeoutMs: 700 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.match(r.error, /timed out/);
});

test("runtime: a skill with no handler.js errors clearly", async () => {
  const home = await makeHome();
  await writeSkill(home, "docsonly", undefined);
  await assert.rejects(() => runSkill({ home, name: "docsonly" }), /no handler\.js/);
});

test("runtime: writes skills/package.json so handlers resolve as ESM", async () => {
  const home = await makeHome();
  await writeSkill(home, "noop", "export default async () => 'ok';");
  await runSkill({ home, name: "noop" });
  const pkg = JSON.parse(await fs.readFile(path.join(home, "skills", "package.json"), "utf8"));
  assert.equal(pkg.type, "module");
});

test("tool: RunSkill runs a SkillCraft-crafted skill and emits skill_ran", async () => {
  const home = await makeHome();
  process.env.ARES_HOME = home;
  const seen = [];
  const off = onLifecycle((e) => {
    if (e.type === "skill_ran") seen.push(e);
  });
  try {
    await SkillCraftTool.call(
      {
        action: "create",
        name: "double",
        description: "doubles a number",
        handler_js: "export default async (input) => ({ doubled: (input?.n ?? 0) * 2 });",
      },
      ctx,
    );

    const ran = await RunSkillTool.call({ name: "double", input: { n: 21 } }, ctx);
    assert.equal(ran.output.ok, true, ran.output.error);
    assert.deepEqual(ran.output.result, { doubled: 42 });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].ok, true);
    assert.ok(seen[0].gain && seen[0].gain.target === "SKILL");
  } finally {
    off();
    delete process.env.ARES_HOME;
  }
});
