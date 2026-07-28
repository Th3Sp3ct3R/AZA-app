// Skill Manifest v2 — `provides` capabilities + `surfaces` buttons, and the
// generic invoke path that powers both a tray click and a TTS provider skill.
// The point: the built-in voice is just the DEFAULT provider — any skill that
// answers the tts contract can override it.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { inferSkillProvides, parseSurfaces } from "../packages/cli/dist/entry/daemon.js";
import { runSkill } from "../packages/agent/dist/skills/runtime.js";

test("parseSurfaces: valid JSON array → validated surfaces", () => {
  const s = parseSurfaces('[{"id":"brief","label":"Daily brief","icon":"📋","input":{"op":"brief"}}]');
  assert.equal(s.length, 1);
  assert.equal(s[0].id, "brief");
  assert.equal(s[0].label, "Daily brief");
  assert.equal(s[0].kind, "button");
  assert.deepEqual(s[0].input, { op: "brief" });
});

test("parseSurfaces: drops malformed / unlabeled entries, tolerates junk", () => {
  assert.deepEqual(parseSurfaces(""), []);
  assert.deepEqual(parseSurfaces("not json"), []);
  assert.deepEqual(parseSurfaces('{"id":"x"}'), []); // object, not array
  const s = parseSurfaces('[{"id":"ok","label":"OK"},{"id":"no-label"},{"label":"no-id"},42]');
  assert.equal(s.length, 1);
  assert.equal(s[0].id, "ok");
});

test("parseSurfaces: caps the tray at 12", () => {
  const many = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, label: `B${i}` })));
  assert.equal(parseSurfaces(many).length, 12);
});

test("inferSkillProvides: recognizes TTS skills that omit frontmatter", () => {
  const surfaces = parseSurfaces('[{"id":"test_voice","label":"Test Voice","input":{"op":"tts","text":"hello"}}]');
  assert.deepEqual(inferSkillProvides("tts", "---\nname: tts\n---\n# TTS\n", [], []), ["tts"]);
  assert.deepEqual(inferSkillProvides("custom_voice", "---\nname: custom_voice\n---\n# Voice\n", surfaces, []), ["tts"]);
  assert.deepEqual(inferSkillProvides("voicebox", "This provides the tts capability for Ares.", [], ["custom"]), ["custom", "tts"]);
});

test("inferSkillProvides: tts-ish names and known engines register as voice providers", () => {
  assert.deepEqual(inferSkillProvides("piper_tts", "---\nname: piper_tts\n---\n# Piper\n", [], []), ["tts"]);
  assert.deepEqual(inferSkillProvides("tts-eleven", "---\nname: tts-eleven\n---\n# Eleven\n", [], []), ["tts"]);
  assert.deepEqual(inferSkillProvides("myvoice", "Talks to the local Kokoro daemon for speech.", [], []), ["tts"]);
  // "cutts" must NOT match — tts has to be its own name segment.
  assert.deepEqual(inferSkillProvides("cutter", "---\nname: cutter\n---\n# Cuts video\n", [], []), []);
});

test("inferSkillProvides: recognizes STT skills the same way", () => {
  const surfaces = parseSurfaces('[{"id":"listen","label":"Transcribe","input":{"op":"transcribe"}}]');
  assert.deepEqual(inferSkillProvides("stt", "---\nname: stt\n---\n# STT\n", [], []), ["stt"]);
  assert.deepEqual(inferSkillProvides("my_ears", "---\nname: my_ears\n---\n# Ears\n", surfaces, []), ["stt"]);
  assert.deepEqual(inferSkillProvides("deepgram", "A speech-to-text provider for Ares.", [], []), ["stt"]);
  // A plain skill infers nothing.
  assert.deepEqual(inferSkillProvides("weather", "---\nname: weather\n---\n# Weather\n", [], []), []);
});

test("tts provider contract: a skill handler answers voices + tts ops", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ares-skill-tts-"));
  try {
    const skillDir = path.join(home, "skills", "my_piper");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: my_piper\ndescription: a test voice provider\nprovides: tts\n---\n# my_piper\n`,
      "utf8",
    );
    // A handler that honors the provider contract: {op:"voices"} and {op:"tts"}.
    await writeFile(
      path.join(skillDir, "handler.js"),
      `export default async function handler(input) {
        if (input?.op === "voices") return { voices: [{ id: "test-1", label: "Test One" }] };
        if (input?.op === "tts") return { audio: Buffer.from("fake-wav-" + (input.text ?? "")).toString("base64"), mime: "audio/wav" };
        return { ok: false, error: "unknown op" };
      }`,
      "utf8",
    );

    const voices = await runSkill({ home, name: "my_piper", input: { op: "voices" } });
    assert.equal(voices.ok, true, voices.error);
    assert.deepEqual(voices.result.voices, [{ id: "test-1", label: "Test One" }]);

    const spoken = await runSkill({ home, name: "my_piper", input: { op: "tts", text: "hello", voice: "test-1", speed: 1 } });
    assert.equal(spoken.ok, true, spoken.error);
    assert.equal(spoken.result.mime, "audio/wav");
    assert.equal(Buffer.from(spoken.result.audio, "base64").toString(), "fake-wav-hello");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
