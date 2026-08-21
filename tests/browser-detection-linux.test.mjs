// Contract for where Ares looks for a Chromium-family browser on Linux
// (linuxChromiumCandidates in packages/connectors/src/playwrightBrowser.ts).
//
// The regression this guards: detection probed six fixed `/usr/bin/...` paths,
// so a machine whose browser came from anywhere else — a snap, /usr/local/bin,
// a vendor .deb under /opt — looked to Ares like a machine with no browser at
// all, and every session fell through to Playwright's bundled Chromium.
//
// The list is pure: it reads PATH and returns paths, touching no filesystem, so
// these tests run identically on any runner regardless of what is installed.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { linuxChromiumCandidates } from "../packages/connectors/dist/index.js";

const withPath = (value, fn) => {
  const previous = process.env.PATH;
  // Assigning undefined to a process.env key stores the string "undefined";
  // deleting is the only way to actually unset it.
  if (value === undefined) delete process.env.PATH;
  else process.env.PATH = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
};

test("the distro paths that used to be the whole list are still covered", () => {
  const candidates = withPath("", linuxChromiumCandidates);
  for (const name of [
    "google-chrome",
    "google-chrome-stable",
    "microsoft-edge",
    "microsoft-edge-stable",
    "chromium",
    "chromium-browser",
  ]) {
    assert.ok(
      candidates.includes(`/usr/bin/${name}`),
      `/usr/bin/${name} must remain a candidate`,
    );
  }
});

test("non-distro install prefixes are searched", () => {
  const candidates = withPath("", linuxChromiumCandidates);
  assert.ok(candidates.includes("/usr/local/bin/google-chrome"), "manual installs");
  assert.ok(candidates.includes("/snap/bin/chromium"), "snap packages");
  assert.ok(candidates.includes("/opt/google/chrome/chrome"), "vendor deb/rpm layout");
  assert.ok(candidates.includes("/opt/microsoft/msedge/msedge"), "vendor deb/rpm layout");
});

test("directories on PATH are searched", () => {
  const candidates = withPath(
    ["/opt/custom/bin", "/home/tester/.local/bin"].join(":"),
    linuxChromiumCandidates,
  );
  assert.ok(candidates.includes("/opt/custom/bin/chromium"));
  assert.ok(candidates.includes("/home/tester/.local/bin/google-chrome"));
});

test("browser preference outranks directory order", () => {
  // Detection exists to find the user's real browser, whose fingerprint is the
  // whole point; finding *a* Chromium first would defeat it. So every Chrome
  // candidate must precede every Chromium candidate, wherever each one lives.
  const candidates = withPath("/opt/custom/bin", linuxChromiumCandidates);
  const lastChrome = candidates.findLastIndex((c) => c.includes("google-chrome"));
  const firstChromium = candidates.findIndex((c) => /chromium/.test(c));
  assert.ok(
    lastChrome < firstChromium,
    "Chrome candidates must all come before Chromium candidates",
  );
});

test("a directory listed twice does not produce a duplicate candidate", () => {
  // /usr/bin is both hardcoded and almost always on PATH.
  const candidates = withPath(["/usr/bin", "/usr/bin"].join(":"), linuxChromiumCandidates);
  assert.equal(new Set(candidates).size, candidates.length);
});

test("an unset PATH is not treated as a directory", () => {
  const candidates = withPath(undefined, linuxChromiumCandidates);
  assert.ok(candidates.every((c) => path.posix.isAbsolute(c)), "no relative candidates");
  assert.ok(!candidates.some((c) => c.startsWith("undefined")));
});

test("a relative PATH entry is ignored", () => {
  // "." and "bin" are legal PATH entries. Kept as candidates they would be
  // resolved by existsSync against the daemon's cwd, which is the operator's
  // workspace — a file named `chromium` there is not a browser.
  const candidates = withPath([".", "bin", "/opt/custom/bin"].join(":"), linuxChromiumCandidates);
  assert.ok(candidates.every((c) => path.posix.isAbsolute(c)), "no relative candidates");
  assert.ok(!candidates.includes("chromium"), "a bare cwd-relative name is not a candidate");
  assert.ok(candidates.includes("/opt/custom/bin/chromium"), "absolute entries still counted");
});
