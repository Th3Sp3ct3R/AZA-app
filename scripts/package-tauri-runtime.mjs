import { build } from "esbuild";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, "tauri", "src-tauri", "runtime");
const cliOut = path.join(runtime, "cli", "ares-cli.mjs");
const templatesOut = path.join(runtime, "templates");
const voiceServiceOut = path.join(runtime, "voice_service");
const binOut = path.join(runtime, "bin");
const modulesOut = path.join(runtime, "node_modules");
const nodeName = process.platform === "win32" ? "node.exe" : "node";

await rm(runtime, { recursive: true, force: true });
await mkdir(path.dirname(cliOut), { recursive: true });
await mkdir(templatesOut, { recursive: true });
await mkdir(binOut, { recursive: true });
await mkdir(modulesOut, { recursive: true });

await build({
  entryPoints: [path.join(root, "packages", "cli", "src", "entry.ts")],
  outfile: cliOut,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["better-sqlite3", "playwright", "react-devtools-core", "sqlite-vec", "pdfjs-dist/*"],
  banner: {
    js: [
      'import { createRequire as __aresCreateRequire } from "node:module";',
      "const require = __aresCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  plugins: [
    {
      name: "ignore-ink-devtools",
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^\.\/devtools\.js$/ }, (args) => {
          if (args.importer.includes(`${path.sep}ink${path.sep}build${path.sep}reconciler.js`)) {
            return { path: "ink-devtools-shim", namespace: "ares-shim" };
          }
          return null;
        });
        pluginBuild.onLoad({ filter: /^ink-devtools-shim$/, namespace: "ares-shim" }, () => ({
          contents: "export {};",
          loader: "js",
        }));
      },
    },
  ],
  sourcemap: false,
  legalComments: "none",
});

// The detached shell supervisor is spawned BY PATH at runtime
// (ShellRegistry resolves `./ShellSupervisor.js` against import.meta.url,
// which inside the bundle is runtime/cli/ares-cli.mjs). It is not an import,
// so esbuild never pulls it into the CLI bundle — without this second build
// every background shell in the packaged app dies instantly with
// "Background shell failed to launch" while dev keeps working.
await build({
  entryPoints: [path.join(root, "packages", "tools", "src", "ShellSupervisor.ts")],
  outfile: path.join(runtime, "cli", "ShellSupervisor.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  legalComments: "none",
});

await cp(path.join(root, "packages", "agent", "templates"), templatesOut, {
  recursive: true,
});
await cp(path.join(root, "voice_service"), voiceServiceOut, {
  recursive: true,
});
await cp(process.execPath, path.join(binOut, nodeName));

const connectorRequire = createRequire(path.join(root, "packages", "connectors", "package.json"));
const playwrightDir = path.dirname(connectorRequire.resolve("playwright/package.json"));
const playwrightRequire = createRequire(path.join(playwrightDir, "package.json"));
const toolsRequire = createRequire(path.join(root, "packages", "tools", "package.json"));
const pdfjsDir = path.dirname(toolsRequire.resolve("pdfjs-dist/package.json"));
const coreRequire = createRequire(path.join(root, "packages", "core", "package.json"));
const betterSqliteDir = path.dirname(coreRequire.resolve("better-sqlite3/package.json"));
const betterSqliteRequire = createRequire(path.join(betterSqliteDir, "package.json"));
const bindingsDir = path.dirname(betterSqliteRequire.resolve("bindings/package.json"));
const bindingsRequire = createRequire(path.join(bindingsDir, "package.json"));
const runtimePackages = [
  ["playwright", playwrightDir],
  ["playwright-core", path.dirname(playwrightRequire.resolve("playwright-core/package.json"))],
  // Read imports pdf.js lazily. Keep its worker/assets and Apache license
  // intact instead of flattening the package into the single-file CLI bundle.
  ["pdfjs-dist", pdfjsDir],
  // The durable session kernel HARD-requires better-sqlite3, and esbuild leaves
  // native addons external. Without these three the packaged daemon dies at
  // startup with ERR_MODULE_NOT_FOUND before the first turn. better-sqlite3
  // loads its addon through `bindings`, which loads `file-uri-to-path`.
  // The prebuilt .node is what loads; the SQLite amalgamation and the C++ addon
  // sources are 11 MB of installer weight nothing reads at runtime.
  ["better-sqlite3", betterSqliteDir, ["deps", "src", "binding.gyp"]],
  ["bindings", bindingsDir],
  ["file-uri-to-path", path.dirname(bindingsRequire.resolve("file-uri-to-path/package.json"))],
];
for (const [packageName, packageDir, excluded = []] of runtimePackages) {
  const excludedTop = new Set(excluded);
  await cp(packageDir, path.join(modulesOut, packageName), {
    recursive: true,
    dereference: true,
    filter: excludedTop.size
      ? (source) => {
          const relative = path.relative(packageDir, source);
          return !relative || !excludedTop.has(relative.split(path.sep)[0]);
        }
      : undefined,
  });
}

const outputs = [
  cliOut,
  // Spawned by path from ShellRegistry — a missing supervisor is every
  // background shell dead in the packaged app, not a degraded feature.
  path.join(runtime, "cli", "ShellSupervisor.js"),
  path.join(binOut, nodeName),
  path.join(voiceServiceOut, "server.py"),
  path.join(modulesOut, "playwright", "package.json"),
  path.join(modulesOut, "playwright-core", "package.json"),
  path.join(modulesOut, "pdfjs-dist", "LICENSE"),
  // A missing addon here is a dead daemon, not a degraded feature. Fail the
  // package step rather than discovering it on the user's first message.
  path.join(modulesOut, "better-sqlite3", "build", "Release", "better_sqlite3.node"),
  path.join(modulesOut, "bindings", "package.json"),
  path.join(modulesOut, "file-uri-to-path", "package.json"),
];
for (const file of outputs) {
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) {
    throw new Error(`Runtime artifact was not created: ${file}`);
  }
}

console.log(`Packaged Tauri runtime at ${runtime}`);
