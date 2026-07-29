import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  isDocumentMutation,
  livingSurfacePrompt,
  parseLivingSurfaceEnvelope,
} from "../packages/protocol/dist/livingSurface.js";

test("Living Surface parses a fenced, revisioned mutation envelope", () => {
  const parsed = parseLivingSurfaceEnvelope(`Here is the surface:\n\`\`\`ares-surface\n${JSON.stringify({
    version: 1,
    baseRevision: 3,
    narration: "I turned this into mission control.",
    mutations: [
      { op: "replace_region", target: "main", html: '<section data-ares-region="main">Ready</section>' },
      { op: "set_title", title: "Mission Control" },
    ],
  })}\n\`\`\``);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.envelope?.baseRevision, 3);
  assert.equal(parsed.envelope?.mutations.length, 2);
  assert.equal(parsed.envelope?.narration, "I turned this into mission control.");
});

test("Living Surface accepts a bare JSON envelope when a model drops its fence", () => {
  const parsed = parseLivingSurfaceEnvelope(JSON.stringify({
    version: 1,
    baseRevision: 0,
    mutations: [{ op: "set_css", css: ":root{--accent:#f50}" }],
  }));
  assert.equal(parsed.envelope?.mutations[0].op, "set_css");
});

test("Living Surface carries document scripts and live posts", () => {
  const parsed = parseLivingSurfaceEnvelope(JSON.stringify({
    version: 1,
    baseRevision: 2,
    mutations: [
      { op: "replace_document", html: '<main data-ares-region="main"><canvas id="game"></canvas></main>', js: "startGame();" },
      { op: "set_script", js: "console.log('patched loop')" },
      { op: "post", payload: { kind: "chat", from: "ares", text: "I'm in the room." } },
    ],
  }));
  assert.equal(parsed.error, undefined);
  const [doc, script, post] = parsed.envelope?.mutations ?? [];
  assert.equal(doc.js, "startGame();");
  assert.equal(script.op, "set_script");
  assert.equal(post.op, "post");
  assert.equal(post.payload.text, "I'm in the room.");
  assert.equal(isDocumentMutation(doc), true);
  assert.equal(isDocumentMutation(post), false);
});

test("Living Surface allows an INHABIT reply with only posts or narration", () => {
  const postsOnly = parseLivingSurfaceEnvelope(JSON.stringify({
    version: 1,
    baseRevision: 5,
    mutations: [{ op: "post", payload: "pong" }],
  }));
  assert.equal(postsOnly.error, undefined);
  const narrationOnly = parseLivingSurfaceEnvelope(JSON.stringify({
    version: 1,
    baseRevision: 5,
    narration: "Nothing needed to change.",
    mutations: [],
  }));
  assert.equal(narrationOnly.error, undefined);
  const empty = parseLivingSurfaceEnvelope(JSON.stringify({ version: 1, baseRevision: 5, mutations: [] }));
  assert.match(empty.error ?? "", /at least one mutation or a narration/);
});

test("Living Surface rejects stale protocol versions and unsafe target syntax", () => {
  const old = parseLivingSurfaceEnvelope(JSON.stringify({ version: 9, baseRevision: 0, mutations: [{ op: "set_title", title: "x" }] }));
  assert.match(old.error ?? "", /Unsupported/);
  const badTarget = parseLivingSurfaceEnvelope(JSON.stringify({
    version: 1,
    baseRevision: 0,
    mutations: [{ op: "replace_region", target: "main\"] body", html: "oops" }],
  }));
  assert.match(badTarget.error ?? "", /Mutation 1/);
});

test("Living Surface enforces bounded patch counts and payload sizes", () => {
  const many = parseLivingSurfaceEnvelope(JSON.stringify({
    version: 1,
    baseRevision: 0,
    mutations: Array.from({ length: 25 }, () => ({ op: "set_title", title: "x" })),
  }));
  assert.match(many.error ?? "", /at most 24/);
  const huge = parseLivingSurfaceEnvelope(JSON.stringify({
    version: 1,
    baseRevision: 0,
    mutations: [{ op: "replace_document", html: "x".repeat(120_001) }],
  }));
  assert.match(huge.error ?? "", /size limit/);
  const hugeScript = parseLivingSurfaceEnvelope(JSON.stringify({
    version: 1,
    baseRevision: 0,
    mutations: [{ op: "set_script", js: "x".repeat(120_001) }],
  }));
  assert.match(hugeScript.error ?? "", /size limit/);
  const hugePost = parseLivingSurfaceEnvelope(JSON.stringify({
    version: 1,
    baseRevision: 0,
    mutations: [{ op: "post", payload: "x".repeat(16_001) }],
  }));
  assert.match(hugePost.error ?? "", /size limit/);
});

test("Living Surface prompt teaches FORGE/INHABIT and carries a bounded snapshot", () => {
  const prompt = livingSurfacePrompt({
    request: "Build a research room",
    revision: 7,
    title: "Lab",
    regions: ["main", "sources"],
    htmlSummary: "x".repeat(30_000),
    jsSummary: "y".repeat(30_000),
    faults: ["TypeError: boom"],
  });
  assert.match(prompt, /baseRevision\": 7/);
  assert.match(prompt, /main, sources/);
  assert.match(prompt, /Build a research room/);
  assert.match(prompt, /FORGE/);
  assert.match(prompt, /INHABIT/);
  assert.match(prompt, /ares\.onPost/);
  assert.match(prompt, /LOCAL FIRST/);
  assert.match(prompt, /QUALITY BAR/);
  assert.match(prompt, /TypeError: boom/);
  assert.ok(prompt.length < 34_000, `prompt unexpectedly large: ${prompt.length}`);
  assert.ok(!prompt.includes("[IN-SURFACE INTERACTION] The user is interacting"));
});

test("Living Surface serves the generated document over its own scheme, never srcdoc, in native builds", () => {
  // A srcdoc iframe inherits the app CSP: packaged builds inject style hashes
  // and script-src 'self', which silently strip every generated <style> and
  // <script>. The document must be scheme-served so it owns its headers.
  const root = process.cwd();
  const rust = readFileSync(join(root, "tauri", "src-tauri", "src", "main.rs"), "utf8");
  assert.match(rust, /register_uri_scheme_protocol\("ares-surface"/);
  assert.match(rust, /LIVING_SURFACE_CSP/);
  assert.match(rust, /default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'/);
  assert.match(rust, /fn ares_living_surface_stage/);
  const conf = readFileSync(join(root, "tauri", "src-tauri", "tauri.conf.json"), "utf8");
  assert.match(conf, /frame-src[^;"]*ares-surface:[^;"]*http:\/\/ares-surface\.localhost/);
  const tsx = readFileSync(join(root, "tauri", "src", "LivingSurface.tsx"), "utf8");
  assert.match(tsx, /ares_living_surface_stage/);
  assert.match(tsx, /native \? \{ src: frameSrc \?\? undefined \} : \{ srcDoc:/);
  assert.match(tsx, /sandbox="allow-scripts allow-forms allow-pointer-lock"/);
  assert.ok(!tsx.includes('sandbox="allow-scripts allow-same-origin'), "scripts must never combine with same-origin");
});

test("Living Surface prompt tags in-surface interactions for INHABIT routing", () => {
  const prompt = livingSurfacePrompt({
    request: "hey ares, you there?",
    revision: 2,
    title: "Darknet Room",
    regions: ["feed"],
    htmlSummary: "<main data-ares-region=\"feed\"></main>",
    fromSurface: true,
  });
  assert.match(prompt, /\[IN-SURFACE INTERACTION\][\s\S]*FORBIDDEN[\s\S]*USER REQUEST:/);
});
