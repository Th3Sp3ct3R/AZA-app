import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

test("pill presence uses a monitor overlay that cannot intercept the real mouse", () => {
  const rust = read("tauri", "src-tauri", "src", "main.rs");
  const app = read("tauri", "src", "App.tsx");
  const capability = JSON.parse(read("tauri", "src-tauri", "capabilities", "default.json"));

  assert.match(rust, /WebviewWindowBuilder::new\([\s\S]*?"presence-overlay"/);
  assert.match(rust, /set_ignore_cursor_events\(true\)/);
  assert.match(rust, /WindowEvent::Focused\(_\)[\s\S]*?hide_windows_accent_border/);
  assert.match(rust, /\.always_on_top\(true\)/);
  assert.ok(capability.windows.includes("presence-overlay"));
  assert.match(app, /invoke\("ares_presence_update"/);
  assert.match(app, /function PresenceOverlay\(/);
  assert.doesNotMatch(app, /className="pillCaption"/);
});

test("hands-free capture defaults favor prompt wake and end-of-utterance response", () => {
  const voice = read("voice_service", "server.py");
  const app = read("tauri", "src", "App.tsx");
  const rust = read("tauri", "src-tauri", "src", "main.rs");

  assert.match(voice, /ARES_STT_VAD_SILENCE", "0\.62"/);
  assert.match(voice, /CRIX_STT_MODEL", "base\.en"/);
  assert.match(voice, /heard\["last"\] >= 0\.32/);
  assert.match(app, /\}, 32\);/);
  assert.doesNotMatch(app, /const acks = \[/);
  assert.match(app, /voiceEngine\.phase === "running"/);
  assert.match(app, /heardSpeech && now - lastVoice >= 650/);
  assert.match(rust, /Voice engine restarted automatically/);
  assert.match(rust, /set_ignore_cursor_events\(true\)/);
});

test("floating pill stays a compact instrument strip", () => {
  const app = read("tauri", "src", "App.tsx");
  assert.match(app, /const PILL_W = 276;/);
  assert.match(app, /const PILL_H = 42;/);
  assert.doesNotMatch(app, /aria-label="minimize"/);
});

test("dynamic voice ports are permitted by the desktop CSP", () => {
  const config = JSON.parse(read("tauri", "src-tauri", "tauri.conf.json"));
  assert.match(config.app.security.csp, /connect-src[^;]*\bws:/);
});
