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
  external: ["better-sqlite3", "playwright", "react-devtools-core", "sqlite-vec"],
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
const runtimePackages = [
  ["playwright", playwrightDir],
  ["playwright-core", path.dirname(playwrightRequire.resolve("playwright-core/package.json"))],
];
for (const [packageName, packageDir] of runtimePackages) {
  await cp(packageDir, path.join(modulesOut, packageName), {
    recursive: true,
    dereference: true,
  });
}

const outputs = [
  cliOut,
  path.join(binOut, nodeName),
  path.join(voiceServiceOut, "server.py"),
  path.join(modulesOut, "playwright", "package.json"),
  path.join(modulesOut, "playwright-core", "package.json"),
];
for (const file of outputs) {
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) {
    throw new Error(`Runtime artifact was not created: ${file}`);
  }
}

console.log(`Packaged Tauri runtime at ${runtime}`);
