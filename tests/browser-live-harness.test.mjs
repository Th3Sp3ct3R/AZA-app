// Opt-in live acceptance harness for the real Browser tool against Expand
// Testing's public automation-practice site. Deterministic unit tests remain the
// CI floor; set ARES_LIVE_BROWSER_HARNESS=1 to exercise network + real Chromium.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { makeBrowserTool } from "../packages/cli/dist/entry/browserBridge.js";
import { cliRuntimeContext } from "../packages/cli/dist/entry/runtime.js";
import { createPlaywrightBrowser } from "../packages/connectors/dist/index.js";

const live = process.env.ARES_LIVE_BROWSER_HARNESS === "1";

test("live Browser harness: DOM batch, selector fill, click, observation, and pixels", { skip: !live, timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-live-browser-"));
  const previousHome = process.env.ARES_HOME;
  const previousDiscovery = process.env.ARES_BROWSER_CDP_DISCOVERY;
  process.env.ARES_HOME = root;
  process.env.ARES_BROWSER_CDP_DISCOVERY = "0";
  const tool = makeBrowserTool(cliRuntimeContext({ workspace: root, home: root }), createPlaywrightBrowser);
  const ctx = {
    workspace: root,
    signal: new AbortController().signal,
    requestPermission: async () => "allow_once",
  };
  try {
    const inputs = await tool.call({
      action: "act",
      headless: true,
      steps: [
        { action: "open", url: "https://practice.expandtesting.com/inputs" },
        { action: "fill_selector", selector: "input[type=text]", value: "Ares harness" },
        { action: "eval", js: "document.querySelector('input[type=text]').value" },
      ],
    }, ctx);
    assert.equal(inputs.output.status, "committed");
    assert.equal(inputs.output.result.completed.at(-1).result, "Ares harness");
    assert.ok(inputs.output.result.observed.length > 0, "final accessibility observation returned");
    assert.equal(inputs.images.length, 1, "final pixel proof returned");

    const dynamic = await tool.call({
      action: "act",
      headless: true,
      steps: [
        { action: "open", url: "https://practice.expandtesting.com/add-remove-elements" },
        { action: "click_text", query: "Add Element" },
        { action: "eval", js: "document.querySelectorAll('.added-manually').length" },
      ],
    }, ctx);
    assert.equal(dynamic.output.status, "committed");
    assert.equal(dynamic.output.result.completed.at(-1).result, 1);
  } finally {
    await tool.call({ action: "close" }, ctx).catch(() => undefined);
    if (previousHome === undefined) delete process.env.ARES_HOME;
    else process.env.ARES_HOME = previousHome;
    if (previousDiscovery === undefined) delete process.env.ARES_BROWSER_CDP_DISCOVERY;
    else process.env.ARES_BROWSER_CDP_DISCOVERY = previousDiscovery;
    await rm(root, { recursive: true, force: true });
  }
});
