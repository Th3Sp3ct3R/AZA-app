// The persona gate — the per-session memory that makes an owner's decision hold.
//
// Every case here is the same reported bug from a different angle: the owner
// pressed "Back to Ares", typed their next message, and the persona was back
// before they finished reading the reply. Matching was stateless, so the button
// was never actually a decision — it was a one-turn preference that the next
// sentence containing "fix" overruled.
//
// These tests pin the two properties that fix it: a release is a STANDING order
// until the owner wears something on purpose again, and a persona is offered at
// most once per session, because a suggestion the owner ignored is an answer.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listPersonas } from "../packages/agent/dist/index.js";
import {
  applyPersonaToolResult,
  newPersonaGate,
  personaForMessage,
} from "../packages/cli/dist/entry/daemon/personas.js";

/** A LiveSession stand-in: personaForMessage only touches these three members. */
function fakeLive(home) {
  let worn = null;
  return {
    context: { home },
    activePersona: () => worn,
    adoptPersona: (p) => {
      worn = p;
    },
  };
}

/** A roster home with one eager persona, so "auto" is exercised on purpose
 *  rather than depending on what the built-ins happen to ship as. */
async function rosterHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), "ares-gate-"));
  await mkdir(path.join(home, "roster", "hammer"), { recursive: true });
  await writeFile(
    path.join(home, "roster", "hammer", "AGENT.md"),
    [
      "---",
      "label: Hammer",
      "description: Builds things.",
      "autonomy: auto",
      "triggers:",
      "  - implement the thing",
      "---",
      "You are working as Hammer.",
    ].join("\n"),
    "utf8",
  );
  return home;
}

const MSG = "please implement the thing today";

test("built-in personas offer rather than seize", async () => {
  // Forge's triggers ("fix", "build", "add a") match nearly every message sent
  // to a coding agent. As `auto` that meant it took the wheel on turn one of
  // almost every conversation, which is what made the roster feel like a trap.
  const builtins = (await listPersonas(await mkdtemp(path.join(os.tmpdir(), "ares-empty-")))).filter(
    (p) => p.source === "builtin",
  );
  assert.ok(builtins.length > 0, "expected built-ins to exist");
  for (const p of builtins) {
    assert.notEqual(p.autonomy, "auto", `built-in ${p.name} must offer, not seize`);
  }
});

test("an auto persona still adopts on the first matching message", async () => {
  const home = await rosterHome();
  const live = fakeLive(home);
  const events = [];
  const gate = newPersonaGate();

  const adopted = await personaForMessage(live, MSG, (e) => events.push(e), gate);
  assert.equal(adopted?.name, "hammer");
  assert.equal(live.activePersona()?.name, "hammer");
  assert.equal(events[0]?.type, "persona_changed");
});

test("release is a standing order — the next matching message does NOT re-adopt", async () => {
  const home = await rosterHome();
  const live = fakeLive(home);
  const gate = newPersonaGate();
  await personaForMessage(live, MSG, () => {}, gate);

  // What "Back to Ares" does, daemon-side.
  live.adoptPersona(null);
  gate.off = true;

  const again = await personaForMessage(live, MSG, () => {}, gate);
  assert.equal(again, null, "the owner said Ares; the keyword does not get to overrule that");
  assert.equal(live.activePersona(), null);
});

test("wearing one on purpose re-opens the session to personas", async () => {
  const home = await rosterHome();
  const live = fakeLive(home);
  const gate = newPersonaGate();
  gate.off = true;

  // An agent-side adopt only happens because the owner asked for it.
  applyPersonaToolResult(live, { action: "adopt", ok: true, persona: { name: "hammer", label: "Hammer" } }, () => {}, gate);
  assert.equal(gate.off, false);

  // ...and releasing again re-arms the standing order.
  applyPersonaToolResult(live, { action: "release", ok: true }, () => {}, gate);
  assert.equal(gate.off, true);
  assert.equal(live.activePersona(), null);
});

test("a persona is offered at most once per session", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ares-gate-"));
  await mkdir(path.join(home, "roster", "scout"), { recursive: true });
  await writeFile(
    path.join(home, "roster", "scout", "AGENT.md"),
    // A trigger no built-in shares: a near-tie adopts nobody, and this test is
    // about the offer count, not about tie-breaking.
    ["---", "label: Scout", "autonomy: suggest", "triggers:", "  - reconnoitre the perimeter", "---", "You are Scout."].join("\n"),
    "utf8",
  );
  const live = fakeLive(home);
  const gate = newPersonaGate();
  const events = [];

  await personaForMessage(live, "go reconnoitre the perimeter for me", (e) => events.push(e), gate);
  await personaForMessage(live, "now reconnoitre the perimeter again", (e) => events.push(e), gate);
  await personaForMessage(live, "reconnoitre the perimeter one more time", (e) => events.push(e), gate);

  const offers = events.filter((e) => e.type === "persona_suggested");
  assert.equal(offers.length, 1, "an ignored suggestion is an answer — asking every turn is nagging");
  assert.equal(offers[0].persona.name, "scout");
});

test("with no gate at all the old stateless behaviour still works", async () => {
  // The gate is optional so non-daemon callers (tests, other channels) don't
  // have to thread one through to get a match.
  const home = await rosterHome();
  const live = fakeLive(home);
  const adopted = await personaForMessage(live, MSG, () => {});
  assert.equal(adopted?.name, "hammer");
});
