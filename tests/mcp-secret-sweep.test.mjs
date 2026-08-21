// The plaintext sweep — legacy `authToken` and custom `headers` in
// ~/.ares/mcp-remote.json move into the encrypted vault on load and never
// come back. Pins:
//   1. after one load, the config file carries NO secret material;
//   2. the swept secrets resolve at call time (bearer + headers);
//   3. an already-vaulted token outranks the plaintext leftover it superseded;
//   4. the sweep is idempotent — a clean file is not rewritten;
//   5. an oauth entry keeps its oauth identity, gaining only vaulted headers.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadRemoteMcpServers,
  getMcpCallCredentials,
  setMcpServerToken,
} from "../packages/core/dist/index.js";

function freshHome() {
  return mkdtempSync(path.join(os.tmpdir(), "ares-mcp-sweep-"));
}

function writeConfig(home, servers) {
  writeFileSync(path.join(home, "mcp-remote.json"), JSON.stringify({ servers }, null, 2) + "\n", "utf8");
}

test("legacy authToken and headers are swept into the vault and stripped from disk", async () => {
  const home = freshHome();
  try {
    writeConfig(home, {
      legacy: {
        url: "https://mcp.example.com",
        authToken: "sk-legacy-plaintext-token",
        headers: { "x-api-key": "hdr-secret-value", "x-tenant": "acme" },
      },
    });

    const servers = await loadRemoteMcpServers(home);
    assert.equal(servers.legacy.authToken, undefined, "authToken is stripped from the loaded entry");
    assert.equal(servers.legacy.headers, undefined, "headers are stripped from the loaded entry");
    assert.equal(servers.legacy.vault, true, "the entry now reads as a vault connector");

    const onDisk = readFileSync(path.join(home, "mcp-remote.json"), "utf8");
    assert.ok(!onDisk.includes("sk-legacy-plaintext-token"), "the token never remains on disk");
    assert.ok(!onDisk.includes("hdr-secret-value"), "header secrets never remain on disk");

    const creds = await getMcpCallCredentials("legacy", home);
    assert.equal(creds.bearer, "sk-legacy-plaintext-token", "the swept token resolves at call time");
    assert.deepEqual(creds.headers, { "x-api-key": "hdr-secret-value", "x-tenant": "acme" });
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an already-vaulted token outranks the plaintext leftover", async () => {
  const home = freshHome();
  try {
    // A proper vault connect happened first…
    await setMcpServerToken("https://mcp.example.com", "sk-vaulted-current", { name: "dual", home, fetchImpl: async () => { throw new Error("offline"); } });
    // …then a stale plaintext leftover reappears on disk (old backup restored).
    const raw = JSON.parse(readFileSync(path.join(home, "mcp-remote.json"), "utf8"));
    raw.servers.dual.authToken = "sk-stale-plaintext";
    raw.servers.dual.headers = { "x-api-key": "hdr-new" };
    writeFileSync(path.join(home, "mcp-remote.json"), JSON.stringify(raw, null, 2) + "\n", "utf8");

    await loadRemoteMcpServers(home);
    const creds = await getMcpCallCredentials("dual", home);
    assert.equal(creds.bearer, "sk-vaulted-current", "the vault stays the authority");
    assert.deepEqual(creds.headers, { "x-api-key": "hdr-new" }, "headers still get swept in");
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a clean file is not rewritten (idempotent sweep)", async () => {
  const home = freshHome();
  try {
    writeConfig(home, {
      swept: { url: "https://mcp.example.com", authToken: "sk-one-time" },
    });
    await loadRemoteMcpServers(home);
    const file = path.join(home, "mcp-remote.json");
    const afterSweep = statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await loadRemoteMcpServers(home);
    assert.equal(statSync(file).mtimeMs, afterSweep, "a second load must not touch the file");
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an oauth entry with custom headers keeps its oauth identity", async () => {
  const home = freshHome();
  try {
    writeConfig(home, {
      notion: { url: "https://mcp.notion.com", oauth: true, headers: { "x-region": "eu" } },
    });
    const servers = await loadRemoteMcpServers(home);
    assert.equal(servers.notion.oauth, true, "oauth stays oauth");
    assert.notEqual(servers.notion.vault, true, "an oauth entry does not become a static vault entry");
    assert.equal(servers.notion.headers, undefined, "headers are vaulted regardless");
    const creds = await getMcpCallCredentials("notion", home);
    assert.deepEqual(creds.headers, { "x-region": "eu" });
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
