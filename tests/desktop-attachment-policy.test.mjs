import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));

async function loadPolicy() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ares-attachment-policy-"));
  const outfile = path.join(tmp, "attachments.mjs");
  await esbuild({
    entryPoints: [path.join(here, "..", "tauri", "src", "state", "attachments.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
  return {
    policy: await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`),
    dispose: () => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

test("desktop attachment policy normalizes Windows and legacy JPEG MIME metadata", async () => {
  const { policy, dispose } = await loadPolicy();
  try {
    assert.deepEqual(policy.supportedAttachmentMediaType({ name: "frame.png", type: "" }), {
      mediaType: "image/png",
      looksLikeImage: true,
    });
    assert.deepEqual(policy.supportedAttachmentMediaType({ name: "frame.JPG", type: "application/octet-stream" }), {
      mediaType: "image/jpeg",
      looksLikeImage: true,
    });
    assert.deepEqual(policy.supportedAttachmentMediaType({ name: "frame.jpg", type: "image/jpg" }), {
      mediaType: "image/jpeg",
      looksLikeImage: true,
    });
    assert.deepEqual(policy.supportedAttachmentMediaType({ name: "frame.avif", type: "image/avif" }), {
      mediaType: "",
      looksLikeImage: true,
    });
  } finally {
    dispose();
  }
});

test("desktop rejects aggregate attachment overflow before ownership leaves the composer", async () => {
  const { policy, dispose } = await loadPolicy();
  try {
    assert.equal(policy.attachmentBudgetViolation([], policy.MAX_ATTACH_B64 + 1), "per_image");
    assert.equal(
      policy.attachmentBudgetViolation(Array(policy.MAX_ATTACHMENTS).fill(1), 1),
      "count",
    );
    assert.equal(
      policy.attachmentBudgetViolation([policy.MAX_TOTAL_ATTACH_B64 - 10], 11),
      "total",
    );
    assert.equal(policy.attachmentBudgetViolation([100], 100), null);
  } finally {
    dispose();
  }
});
