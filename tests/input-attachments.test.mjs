import test from "node:test";
import assert from "node:assert/strict";
import { contentFromUserInput } from "../packages/cli/dist/entry/terminalLines.js";

test("image input canonicalizes supported data URLs without collapsing similar frames", async () => {
  const prefix = "A".repeat(120);
  const content = await contentFromUserInput([
    "compare these",
    `data:image/png;name="my screenshot.png";base64,${prefix}AQ==`,
    `data:image/png;base64,${prefix}Ag==`,
  ].join("\n"), process.cwd());

  assert.deepEqual(content.map((block) => block.type), ["text", "image", "image"]);
  assert.doesNotMatch(content[0].text, /base64,/);
  assert.equal(content[1].source.mediaType, "image/png");
  assert.notEqual(content[1].source.data, content[2].source.data);
});

test("image input rejects unsupported MIME and oversized inline payloads explicitly", async () => {
  await assert.rejects(
    contentFromUserInput("data:image/svg+xml;base64,PHN2Zz4=", process.cwd()),
    /unsupported image type image\/svg\+xml/,
  );
  await assert.rejects(
    contentFromUserInput(`data:image/png;base64,${"A".repeat(2_000_001)}`, process.cwd()),
    /too large/,
  );
  await assert.rejects(
    contentFromUserInput("data:image/png;base64,not-valid-$", process.cwd()),
    /malformed (?:base64|image data URL)/,
  );
});
