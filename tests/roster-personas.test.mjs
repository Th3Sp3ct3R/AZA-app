// The roster: persona definitions, trigger matching, and the two invariants
// that make personas safe to let Ares author for itself.
//
// The load-bearing one is ordering: an adopted persona is layered ABOVE the
// sealed core, so it can shift expertise and voice but can never be used to
// relax verification or rewrite the identity. If someone "simplifies"
// composeAgentSystemPrompt by appending the persona last, that guarantee
// silently disappears — hence a test that reads the actual offsets.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  bestPersonaFor,
  composeAgentSystemPrompt,
  deletePersona,
  listPersonas,
  matchPersonas,
  personaFromMarkdown,
  personaToMarkdown,
  personaSlug,
  readPersona,
  renderPersonaLayer,
  writePersona,
} from "../packages/agent/dist/index.js";
import { personaAsSubagentType, registerPersonaSubagents } from "../packages/cli/dist/entry/rosterBridge.js";
import { SubagentRegistry } from "../packages/core/dist/index.js";

async function tempHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "ares-roster-"));
  await mkdir(home, { recursive: true });
  return home;
}

test("built-in personas are available with no roster directory at all", async () => {
  const home = await tempHome();
  const roster = await listPersonas(home);
  assert.ok(roster.length >= 4, `fresh install still has a roster (saw ${roster.length})`);
  for (const p of roster) {
    assert.equal(p.source, "builtin");
    assert.ok(p.body.trim().length > 0, `${p.name} has a body`);
    assert.ok(p.description.trim().length > 0, `${p.name} has a description`);
  }
});

test("a disk persona shadows a built-in of the same name", async () => {
  const home = await tempHome();
  const before = await readPersona("aegis", home);
  assert.equal(before.source, "builtin");

  await writePersona(
    { name: "aegis", label: "Aegis Prime", description: "My own reviewer.", body: "You review MY way.", triggers: ["Review", "AUDIT"] },
    home,
  );
  const after = await readPersona("aegis", home);
  assert.equal(after.source, "roster", "disk wins over the built-in");
  assert.equal(after.label, "Aegis Prime");
  assert.deepEqual(after.triggers, ["review", "audit"], "triggers are normalised to lowercase once, at load");

  // Deleting the override restores the built-in rather than leaving a hole.
  assert.equal(await deletePersona("aegis", home), true);
  assert.equal((await readPersona("aegis", home)).source, "builtin");
});

test("frontmatter parsing tolerates the shapes a model actually emits", () => {
  // A YAML list, an inline comma list, and an inline JSON array must all work:
  // Ares writes these files itself, and a near-miss should still yield a
  // working persona rather than a silently empty one.
  const yamlList = personaFromMarkdown(
    ["---", "label: Block", "triggers:", "  - alpha", "  - 'beta gamma'", "tools:", "  - Read", "---", "Body here."].join("\n"),
    { name: "block" },
  );
  assert.deepEqual(yamlList.triggers, ["alpha", "beta gamma"]);
  assert.deepEqual(yamlList.tools, ["Read"]);
  assert.equal(yamlList.body, "Body here.");

  const commaList = personaFromMarkdown("---\ntriggers: alpha, beta gamma\n---\nBody.", { name: "comma" });
  assert.deepEqual(commaList.triggers, ["alpha", "beta gamma"]);

  const jsonList = personaFromMarkdown('---\ntriggers: ["alpha", "beta gamma"]\n---\nBody.', { name: "json" });
  assert.deepEqual(jsonList.triggers, ["alpha", "beta gamma"]);
});

test("a malformed persona degrades to defaults instead of vanishing", () => {
  const noFrontmatter = personaFromMarkdown("Just a body, no frontmatter at all.", { name: "bare" });
  assert.equal(noFrontmatter.label, "Bare", "label falls back to a title-cased name");
  assert.equal(noFrontmatter.body, "Just a body, no frontmatter at all.");
  assert.equal(noFrontmatter.autonomy, "suggest", "unknown autonomy defaults to the cautious option");
  assert.equal(noFrontmatter.tone, "ivory");

  const junkEnums = personaFromMarkdown("---\ntone: neon\nautonomy: aggressive\n---\nBody.", { name: "junk" });
  assert.equal(junkEnums.tone, "ivory", "an invalid tone does not leak into the UI");
  assert.equal(junkEnums.autonomy, "suggest", "an invalid autonomy never escalates to auto");

  assert.equal(personaFromMarkdown("body", { name: "!!!" }), null, "a nameless persona is rejected outright");
});

test("an unreadable roster entry is skipped, not fatal", async () => {
  const home = await tempHome();
  // A directory with no AGENT.md, and one with an empty AGENT.md.
  await mkdir(path.join(home, "roster", "hollow"), { recursive: true });
  await mkdir(path.join(home, "roster", "blank"), { recursive: true });
  await writeFile(path.join(home, "roster", "blank", "AGENT.md"), "   \n", "utf8");
  await writePersona({ name: "good", body: "A real one." }, home);

  const roster = await listPersonas(home);
  assert.ok(roster.some((p) => p.name === "good"), "the valid persona still loads");
  assert.ok(!roster.some((p) => p.name === "hollow" || p.name === "blank"), "the broken ones are skipped");
});

test("persona markdown round-trips", async () => {
  const home = await tempHome();
  const written = await writePersona(
    {
      name: "round trip!",
      label: "Round Trip",
      description: "Checks serialisation.",
      greeting: "Hello from the round trip.",
      body: "You are working as Round Trip.\n\nMethod:\n- Be exact.",
      triggers: ["round trip", "serialise"],
      tools: ["Read", "Grep"],
      glyph: "scroll",
      tone: "mint",
      autonomy: "manual",
      maxTurns: 12,
    },
    home,
  );
  assert.equal(written.name, "round-trip", "the name is slugged");
  const reread = personaFromMarkdown(personaToMarkdown(written), { name: written.name });
  for (const field of ["label", "description", "greeting", "body", "glyph", "tone", "autonomy", "maxTurns"]) {
    assert.deepEqual(reread[field], written[field], `${field} survives the round trip`);
  }
  assert.deepEqual(reread.triggers, written.triggers);
  assert.deepEqual(reread.tools, written.tools);
});

test("personaSlug refuses to escape the roster directory", () => {
  // path.join does not clamp "..", so the slug is the only thing standing
  // between a model-authored name and a write outside the roster.
  assert.equal(personaSlug("../../etc/passwd"), "etc-passwd");
  assert.equal(personaSlug("..\\..\\windows"), "windows");
  assert.equal(personaSlug("  Spaces  And--Dashes "), "spaces-and-dashes");
  assert.equal(personaSlug("!!!"), "");
});

test("triggers match on word edges and rank by intent", async () => {
  const roster = await listPersonas(await tempHome());

  const research = bestPersonaFor("can you research how the router picks a lane", roster);
  assert.equal(research?.persona.name, "vitruvius");

  const review = bestPersonaFor("please audit this for security problems", roster);
  assert.equal(review?.persona.name, "aegis");

  // "prefix" must not fire the "fix" trigger.
  const prefixed = matchPersonas("the prefix and suffix handling", roster);
  assert.ok(
    !prefixed.some((m) => m.hits.includes("fix")),
    "a trigger inside a longer word does not count as a match",
  );

  assert.equal(bestPersonaFor("hi", roster), null, "a trivial message matches nothing");
  assert.equal(bestPersonaFor("what time is it", roster), null, "an unrelated message matches nothing");
});

test("an ambiguous message adopts nobody", async () => {
  const home = await tempHome();
  // Two personas with identical trigger weight — the intent is genuinely
  // unclear, so guessing is worse than staying plain Ares.
  await writePersona({ name: "twin-a", body: "A", triggers: ["ambiguous"], autonomy: "auto" }, home);
  await writePersona({ name: "twin-b", body: "B", triggers: ["ambiguous"], autonomy: "auto" }, home);
  const roster = await listPersonas(home);
  const matches = matchPersonas("this is ambiguous", roster);
  assert.equal(matches.length, 2, "both are candidates");
  assert.equal(bestPersonaFor("this is ambiguous", roster), null, "but no clear winner means no adoption");
});

test("a manual persona never matches on its own", async () => {
  const home = await tempHome();
  await writePersona({ name: "hermit", body: "H", triggers: ["hermit", "solitude"], autonomy: "manual" }, home);
  const roster = await listPersonas(home);
  assert.equal(matchPersonas("hermit solitude please", roster).length, 0, "manual is excluded from matching");
  assert.ok(await readPersona("hermit", home), "but it is still explicitly adoptable");
});

test("the persona layer sits ABOVE the sealed core, never below it", async () => {
  const home = await tempHome();
  const persona = await writePersona(
    { name: "layered", label: "Layered", body: "PERSONA_BODY_MARKER", greeting: "hi" },
    home,
  );
  const context = {
    home,
    bootstrapRequired: false,
    agentName: "Ares",
    blocks: [],
    systemText: "",
    contextTokens: 0,
    droppedLabels: [],
  };
  const prompt = composeAgentSystemPrompt("BASE_MARKER", context, {
    personaLayer: renderPersonaLayer(persona, "Ares"),
  });

  const personaAt = prompt.indexOf("PERSONA_BODY_MARKER");
  const sealAt = prompt.indexOf("# Core (sealed)");
  const nameSealAt = prompt.lastIndexOf("Your name is Ares;");
  assert.ok(personaAt > 0, "the persona body is present");
  assert.ok(sealAt > 0, "the seal is present");
  assert.ok(personaAt < sealAt, "persona comes BEFORE the sealed core — the seal keeps the last word");
  assert.ok(personaAt < nameSealAt, "and before the closing name anchor, so it cannot displace the name");
  assert.ok(prompt.includes("You are still Ares"), "the layer restates the real identity");

  const plain = composeAgentSystemPrompt("BASE_MARKER", context, {});
  assert.ok(!plain.includes("Active persona"), "no persona layer when none is adopted");
  assert.equal(
    composeAgentSystemPrompt("BASE_MARKER", context),
    plain,
    "omitting the options object behaves identically to passing an empty one",
  );
});

test("every persona is also a delegable subagent type", async () => {
  const home = await tempHome();
  await writePersona(
    { name: "narrow", label: "Narrow", description: "Read-only worker.", body: "Only read.", tools: ["Read", "Grep"], maxTurns: 7 },
    home,
  );
  await writePersona({ name: "wide", label: "Wide", description: "Full belt.", body: "Anything." }, home);

  const registry = new SubagentRegistry();
  const names = registerPersonaSubagents(registry, await listPersonas(home));
  assert.ok(names.includes("narrow") && names.includes("wide"));

  const narrow = registry.get("narrow");
  assert.deepEqual(narrow.toolWhitelist, ["Read", "Grep"], "a persona's tools become a delegation whitelist");
  assert.equal(narrow.maxTurns, 7);
  assert.ok(narrow.systemPrompt.includes("Only read."), "the body becomes the subagent prompt");

  assert.equal(
    registry.get("wide").toolWhitelist,
    undefined,
    "an empty tools list means inherit the full belt — NOT a belt of zero tools",
  );

  // Built-in engine types survive alongside personas.
  assert.ok(registry.get("verifier"), "built-in subagent types are still registered");
});

test("a persona named after a built-in subagent type overrides it", async () => {
  const home = await tempHome();
  await writePersona({ name: "verifier", label: "My Verifier", description: "Mine.", body: "MY_VERIFIER_BODY" }, home);
  const registry = new SubagentRegistry();
  registerPersonaSubagents(registry, await listPersonas(home));
  assert.ok(
    registry.get("verifier").systemPrompt.includes("MY_VERIFIER_BODY"),
    "the more specific definition wins — same rule as disk-over-builtin",
  );
});

test("delegation whitelist and adoption are asymmetric on purpose", async () => {
  // Delegation narrows the child's belt; adoption must not narrow the live
  // session's. This asserts the delegation half — the adoption half is the
  // absence of any tool filtering in the adopt path (sessionFactory only swaps
  // the system prompt).
  const persona = personaFromMarkdown("---\ntools:\n  - Read\n---\nBody.", { name: "reader" });
  const type = personaAsSubagentType(persona);
  assert.deepEqual(type.toolWhitelist, ["Read"]);
  assert.equal(type.name, "reader");
  assert.ok(type.description.includes("authored on disk"), "disk personas are labelled in the delegation menu");
});
