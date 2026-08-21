// Mnemosyne — the standalone memory server. Pins the three mechanisms that
// exist to kill the 2026-08-10 failure class ("wrote it to memory, recalled
// it, did it anyway"):
//  1. Binding classes: law/pact/doctrine CRUD, text dedupe, the LOUD law cap,
//     owner-only law sourcing, and the LAWS.md read-through mirror round-trip.
//  2. Guard compilation: clear imperatives compile (never→deny, ask-before→
//     confirm, always→warn), backticked spans anchor verbatim, vague text
//     compiles to NOTHING (a wrong guard is worse than no guard).
//  3. The attestation loop: outcomes roll onto binding stats and
//     complianceReport flags "recalled but violated".
//  4. The wire: token-authed hello, remember/recall through the server (single
//     writer), the binding packet with prompt block + guards, attest and
//     compliance over the socket, and the LivingRecaller adapter shape.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  addBinding,
  loadBindings,
  retireBinding,
  alwaysOnBindings,
  importLawsFile,
  exportLawsFile,
  compileGuard,
  evaluateGuards,
  strongestVerdict,
  recordAttestations,
  loadAttestations,
  complianceReport,
  renderBindingBlock,
  MnemosyneServer,
  MnemosyneClient,
  ensureToken,
  MAX_LAWS,
  mnemosynePaths,
} from "../packages/mnemosyne/dist/index.js";

async function tmpHome() {
  return mkdtemp(path.join(tmpdir(), "ares-mnemosyne-"));
}

// ── guards ──────────────────────────────────────────────────────────────────

test("compileGuard: never → deny with salient anchors", () => {
  const g = compileGuard("Never run `git clean` in the workspace");
  assert.ok(g);
  assert.equal(g.effect, "deny");
  assert.ok(g.match.includes("git clean"));
  assert.match(g.reason, /Never run/);
});

test("compileGuard: ask before → confirm; always → warn; vague → null", () => {
  assert.equal(compileGuard("Always ask before pushing to origin")?.effect, "confirm");
  assert.equal(compileGuard("Ask me first before deleting branches")?.effect, "confirm");
  assert.equal(compileGuard("Always update the changelog before tagging")?.effect, "warn");
  // Not an imperative — must NOT compile.
  assert.equal(compileGuard("The build takes about five minutes"), null);
  // Imperative but zero salient anchors — must NOT compile.
  assert.equal(compileGuard("Never do it"), null);
});

test("evaluateGuards: conjunction matching + strongestVerdict ranking", () => {
  const deny = compileGuard("never run `git clean`");
  const confirm = compileGuard("always ask before pushing");
  const verdicts = evaluateGuards([deny, confirm], "git clean -xfd && git push");
  assert.equal(verdicts.filter((v) => v.tripped).length, 2);
  assert.equal(strongestVerdict(verdicts)?.guard.effect, "deny");
  const quiet = evaluateGuards([deny, confirm], "git status");
  assert.equal(strongestVerdict(quiet), null);
});

// ── bindings ────────────────────────────────────────────────────────────────

test("addBinding: dedupe by normalized text, retire keeps history", async () => {
  const home = await tmpHome();
  try {
    const a = await addBinding(home, { class: "law", text: "Never push without asking." });
    const b = await addBinding(home, { class: "law", text: "never push without asking" });
    assert.equal(a.id, b.id); // refreshed, not duplicated
    let all = await loadBindings(home);
    assert.equal(all.length, 1);

    assert.equal(await retireBinding(home, a.id), true);
    all = await loadBindings(home);
    assert.equal(all.length, 1);
    assert.equal(all[0].active, false);
    assert.equal(alwaysOnBindings(all).length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("law cap throws LOUDLY; agents cannot source laws (pact instead)", async () => {
  const home = await tmpHome();
  try {
    for (let i = 0; i < MAX_LAWS; i++) {
      await addBinding(home, { class: "law", text: `standing order number ${i} about topic-${i}` });
    }
    await assert.rejects(() => addBinding(home, { class: "law", text: "one law too many here" }), /cap/);
    await assert.rejects(() => addBinding(home, { class: "law", text: "agent law", source: "agent" }), /owner/);
    const pact = await addBinding(home, { class: "pact", text: "I will always ask before pushing" });
    assert.equal(pact.source, "agent");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("LAWS.md mirror: export renders law lines; import round-trips", async () => {
  const home = await tmpHome();
  try {
    await addBinding(home, { class: "law", text: "Never run `git clean` anywhere" });
    await addBinding(home, { class: "pact", text: "I keep the changelog current" });
    await exportLawsFile(home);
    const raw = await readFile(mnemosynePaths(home).lawsFile, "utf8");
    assert.match(raw, /- \[\d{4}-\d{2}-\d{2}\] Never run `git clean` anywhere/);
    assert.ok(!raw.includes("changelog"), "pacts must NOT leak into LAWS.md");

    // Import into a fresh home reconstructs the law binding.
    const home2 = await tmpHome();
    try {
      await writeFile(mnemosynePaths(home2).lawsFile, raw, "utf8");
      const imported = await importLawsFile(home2);
      assert.equal(imported.length, 1);
      assert.equal(imported[0].class, "law");
      assert.match(imported[0].text, /git clean/);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ── attestation ─────────────────────────────────────────────────────────────

test("attestations roll onto stats; complianceReport flags recalled-but-violated", async () => {
  const home = await tmpHome();
  try {
    const law = await addBinding(home, { class: "law", text: "never force-push to main branch" });
    const pact = await addBinding(home, { class: "pact", text: "I summarize before ending a session" });

    await recordAttestations(home, "turn-1", [
      { bindingId: law.id, outcome: "violated" },
      { bindingId: pact.id, outcome: "honored" },
    ]);
    await recordAttestations(home, "turn-2", [
      { bindingId: law.id, outcome: "violated", note: "did it again" },
      { bindingId: pact.id, outcome: "honored" },
    ]);

    const ledger = await loadAttestations(home);
    assert.equal(ledger.length, 4);
    assert.equal((await loadAttestations(home, { bindingId: law.id })).length, 2);

    const report = complianceReport(await loadBindings(home));
    const lawEntry = report.entries.find((e) => e.binding.id === law.id);
    assert.equal(lawEntry.attested, 2);
    assert.equal(lawEntry.violated, 2);
    assert.equal(lawEntry.recalledButViolated, true);
    assert.equal(report.flagged.length, 1);
    assert.equal(report.flagged[0].binding.id, law.id);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ── the wire ────────────────────────────────────────────────────────────────

test("server: health, token gate, remember/recall, packet, attest, compliance", async () => {
  const home = await tmpHome();
  const server = new MnemosyneServer({ home });
  try {
    const { host, port } = await server.start();

    // /health answers on the same port.
    const health = await (await fetch(`http://${host}:${port}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.service, "mnemosyne");

    // Wrong token is rejected.
    const bad = new MnemosyneClient({ url: `ws://${host}:${port}`, token: "0".repeat(32) });
    await assert.rejects(() => bad.connect(), /bad token/);
    bad.close();

    const token = await ensureToken(home);
    const client = new MnemosyneClient({ url: `ws://${host}:${port}`, token });
    const welcome = await client.connect();
    assert.equal(welcome.memories, 0);

    // Single-writer memory through the wire.
    const node = await client.remember("semantic", "The garrison port is 7421");
    assert.ok(node.id);
    const recalled = await client.recall("garrison port", { limit: 3 });
    assert.ok(recalled.length >= 1);
    assert.match(recalled[0].node.content, /7421/);

    // LivingRecaller adapter shape.
    const recaller = client.asLivingRecaller();
    const viaAdapter = await recaller.remember("garrison port", { limit: 2 });
    assert.ok(viaAdapter.length >= 1);

    // Bindings + packet: prompt block + compiled guards ride together.
    const law = await client.addBinding("law", "never run `git clean` here");
    assert.ok(law.guard);
    const packet = await client.bindingsPacket();
    assert.equal(packet.bindings.length, 1);
    assert.equal(packet.guards.length, 1);
    assert.match(packet.promptBlock, /ALWAYS in force/);
    assert.match(packet.promptBlock, /git clean/);
    assert.ok(packet.packetId.startsWith("pkt_"));

    // Adding a law through the wire refreshed the LAWS.md mirror.
    const laws = await readFile(mnemosynePaths(home).lawsFile, "utf8");
    assert.match(laws, /git clean/);

    // Guards evaluate over the wire.
    const verdicts = await client.evalGuards("git clean -xfd");
    assert.equal(verdicts.filter((v) => v.tripped).length, 1);

    // Attest + compliance close the loop.
    await client.attest("turn-9", [{ bindingId: law.id, outcome: "honored" }]);
    const report = await client.compliance();
    assert.equal(report.entries.find((e) => e.binding.id === law.id)?.honored, 1);

    client.close();
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("renderBindingBlock: empty set renders nothing; laws and pacts labeled", () => {
  assert.equal(renderBindingBlock([]), "");
  const block = renderBindingBlock([
    { class: "law", text: "never push without asking" },
    { class: "pact", text: "I verify before claiming done" },
  ]);
  assert.match(block, /\[law\] never push without asking/);
  assert.match(block, /\[pact\] I verify before claiming done/);
  assert.match(block, /attest honestly/);
});
