# Ares Development

## Setup

```powershell
cd D:\Ares
pnpm install
pnpm build
```

The workspace uses `pnpm` and TypeScript project references. The root `tsconfig.json` defines the package build order.

## Common Commands

```powershell
pnpm build    # compile all TypeScript packages
pnpm check    # compile all packages with concise TypeScript output
pnpm lint     # alias for pnpm check
pnpm test     # build, then run the Node test suite
pnpm verify   # lint, build, and test through the standard scripts
pnpm clean    # remove generated build, Tauri, log, and smoke-test output
```

The default long-horizon coding benchmark is `ares eval coding --suite coding-v2`.
It records integrity, proof, false-green, token, prompt, task-manifest, and
tool-schema data under the Ares home. Real-model runs execute candidate code;
run them in a disposable VM/container and pass `--allow-unsafe-process-eval`.

The CLI entrypoint is built to `packages/cli/dist/entry.js`. Use `pnpm build` before running `pnpm ares` or before launching the desktop companion after a clean.

## Permission Posture

Ares is currently tuned as a local owner-operated agent. Interactive CLI sessions start in `bypass` mode unless `%USERPROFILE%\.ares\ui.json` or `$ARES_HOME\ui.json` contains `dangerousBypass: false`.

Permission modes:

- `bypass`: tool prompts are auto-allowed. This is powerful and should be used only in trusted local workspaces.
- `workspace-write`: normal guarded editing mode. Workspace writes are allowed through the permission engine; external or risky operations still need explicit handling.
- `plan`: write tools are blocked so the agent can inspect and propose changes without modifying files.

Use `/plan` or `/code` to return to guarded modes. Use `/danger` or `/bypass` to toggle bypass mode. The toggle persists through `dangerousBypass` in the Ares UI settings file.

## Runtime State

Do not store runtime state in the repository. The default durable Ares home is:

```text
%USERPROFILE%\.ares
```

Ignored generated output includes package `dist/`, TypeScript build-info files, Tauri build output, Tauri generated schemas, logs, and smoke-test screenshots.

`pnpm clean` removes generated repository outputs, including repo-local `.ares/` session artifacts created by tests or local runs. It intentionally does not delete the durable Ares home because that can contain user memory, permissions, and identity state.

## Verification Policy

For cleanup and package-boundary changes, run:

```powershell
pnpm lint
pnpm build
pnpm test
pnpm clean
```

For user-facing CLI behavior, also run the relevant `.\ares.bat ...` command or an equivalent smoke test. For desktop UI changes, take screenshots before and after the change.
