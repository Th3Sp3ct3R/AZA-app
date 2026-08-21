# Claude Handoff: Ares Coding-Harness Reconstruction

This file is the technical handoff for the 2026-08-01 OpenCode/Ares reconstruction task. It is intended to be pasted into Claude or read from the `D:\Ares` working tree.

The user-visible conversation is exported separately at `docs/exports/2026-08-01-opencode-ares-chat-transcript.md`. The complete architecture comparison, invariants, boundaries, fault matrix, and source map are in `docs/CODING-HARNESS-ARCHITECTURE.md`.

## Read this first

The reconstruction is implemented and verified. Do not treat this as a proposal that still needs to be built, and do not replace it with a smaller framework. Preserve the current dirty working tree. No commit, push, reset, stash, or destructive cleanup was performed.

The user's non-negotiable product intent was:

- Coding language must not automatically trigger plan mode.
- Plan mode is explicit and talk-only until the exact plan is approved.
- Ares must work directly in whatever directory/project the user authorizes; no single-directory jail and no edit-in-one-place/copy-to-another behavior.
- Durability, reconciliation, and verification must make Ares more trustworthy without removing its agency or broad tool capabilities.
- Long-running work, child agents, shell jobs, Conductor branches, memory, and verification must survive ordinary Ares/app restarts.
- Read, Write, Edit, ApplyPatch, Bash, and PowerShell should be predictable, bounded, and self-correcting.
- Completion must mean verified work, not merely that a generator stopped.

## Bottom line

OpenCode's strongest idea was not a special model or vector-memory trick. It was a re-entrant harness: persist observable state, project bounded context each step, represent delegation as child sessions, and separate plan authority from build authority.

Ares already had stronger cognition, semantic memory, verification, provider recovery, and fleet orchestration, but those guarantees were fragmented across direct `QueryEngine`, interactive Session, daemon, Garrison, Task, Conductor, and Operator paths. This reconstruction moved those paths onto shared durable contracts.

Ares now has:

- A workspace-local SQLite/WAL Session kernel, currently schema v8.
- Durable FIFO input admission with idempotency keys and caller-bound claims.
- Per-session run leases, heartbeats, generations, token fencing, and expiry takeover.
- Automatic orphan draining when a canonical Session is opened.
- Atomic detached-input results for callerless recovery.
- Durable tool execution/settlement records and explicit ambiguous-effect handling.
- Transactional workspace mutation with CAS, cross-process path leases, receipts, rollback, and reconciliation.
- Hash-bound living plans and atomic plan-to-build handoff.
- Durable Task, Conductor, Operator, and Garrison child Sessions.
- Restartable Task/background jobs and durable shell supervision/output.
- Exact compaction epochs and typed context-source hashes.
- Cross-process Markdown-memory CAS.
- PostToolUse settlement and hash-bound formatter/LSP feedback.
- Direct editing in approved external projects using the target project's own recovery journal.

## Source snapshots used

- OpenCode: pinned commit `19231fce4b70aa5f7894a0a0eb20ff29bd417db5`, researched under `.ares/research/opencode-source`.
- Ares-before: committed baseline `ca48a7f713fa1079af6bbdda7e4a06ebd2622728`.
- Ares-current: the uncommitted reconstruction in this working tree.

The implementation adapts the architecture and contracts to Ares abstractions. It does not claim that OpenCode implementation code was copied. OpenCode is MIT licensed; any future direct port must preserve the license notice and identify copied provenance.

## Architecture implemented

### 1. Canonical Session kernel

Primary files:

- `packages/core/src/sessionKernel/migrations.ts`
- `packages/core/src/sessionKernel/store.ts`
- `packages/core/src/sessionKernel/coordinator.ts`
- `packages/core/src/sessionKernel/workspace.ts`
- `packages/core/src/session.ts`

Important behavior:

- SQLite is the canonical projection for sessions, messages/parts, admitted inputs, runs, tool executions, context epochs, plan revisions, child links, background jobs, detached results, mutation scope, and durable events.
- JSONL remains an audit/legacy compatibility stream; it is not allowed to override canonical SQLite state.
- Inputs commit before the provider can start and before a sender waits for execution ownership.
- Admission order is monotonic and deterministic. Each live sender claims only its own input ID; global oldest-input recovery is reserved for explicit recovery paths.
- A process-local coordinator serializes execution, while the SQLite lease/generation fence protects against cross-process overlap and stale writers.
- Expired generations cannot append messages, settle tools, consume inputs, or mutate canonical state.
- Opening a live canonical Session wakes recovery automatically. Dormant sessions require a host with the correct provider/tool composition; they are not replayed blindly by a generic daemon.
- Finalized deletion writes append-only tombstones so stale JSON or restored files cannot resurrect deleted sessions.
- Ordinary user-input payloads retain their legacy canonical shape (`{content}`); only non-default work-item source metadata is persisted. This prevents false idempotency conflicts when retrying an orphan admitted by an older path.

Schema milestones relevant to this work:

- v7 added atomic detached-input result delivery.
- v8 added canonical `session_mutations` so verifier/mutation scope survives restart.

### 2. QueryEngine and durable effect authority

Primary files:

- `packages/core/src/queryEngine.ts`
- `packages/core/src/forkedTurn.ts`
- `packages/core/src/hooks.ts`
- `packages/tools/src/_shared.ts`

Important behavior:

- User-facing effectful engines must be created by a durable Session host. `QueryEngine.hosted(...)` requires pre-execution and post-execution barriers.
- `QueryEngine.forTesting(...)` is the explicit test/evaluation escape hatch. Do not use it in production composition.
- Tools expose effective per-input safety. Explicit `mayHaveEffects` metadata distinguishes a truly dynamic writer from a read-only tool that merely has an input classifier.
- `runForkedTurn` lazily attaches a canonical Session kernel for static or dynamically effectful compatibility forks. Stable `inputId` values make re-entry return settled canonical history instead of rerunning the provider/tool.
- Genuinely read-only forks remain able to run when `.ares` persistence is unavailable; a telemetry/journal failure cannot break a read-only child job.
- Tool state is admitted before implementation entry and settled before model-visible completion.
- Known validation/permission failures carry a narrow pre-effect marker. An entered writer that throws is not mislabeled as safely retryable.
- Ambiguous non-read-only effects become `effect_unknown`; Ares does not blindly replay them.
- A tool can provide an observational reconciler and an explicit retry contract. Reconciliation is evidence, not automatic authority to repeat an effect.
- Terminal tool records can repair a missing model-visible tool result after a crash.
- PreToolUse/PostToolUse hooks participate in effect accounting. Post hooks settle once as durable child effects rather than running after the parent tool is already declared complete.
- Failed shell/opaque tools retain touched-file evidence so a non-zero exit cannot erase mutations made before failure.

### 3. Transactional editing and arbitrary-project freedom

Primary files:

- `packages/core/src/workspaceMutation.ts`
- `packages/tools/src/ApplyPatch.ts`
- `packages/tools/src/Edit.ts`
- `packages/tools/src/Write.ts`
- `packages/tools/src/FindAndEdit.ts`
- `packages/tools/src/ApplyIntent.ts`
- `packages/tools/src/CodeMode.ts`
- `packages/tools/src/safeWrite.ts`
- `packages/tools/src/_shared.ts`

All core editors route through `WorkspaceMutationService` rather than performing unrelated direct writes.

The mutation service:

- Validates the complete operation set before the first project mutation.
- Supports atomic add/update/delete/rename sets and mode-aware CAS.
- Uses canonical path ordering, in-process serialization, and cross-process filesystem leases.
- Creates immutable rollback backups, stages new bytes, fsyncs, records journals/receipts, and verifies installed content/mode.
- Returns explicit before/after/diverged reconciliation rather than guessing after interruption.
- Fences rollback using the installed file generation, not only content equality.
- Detects same-content external replacements through file identity where the filesystem exposes it.
- Preserves non-cooperating editor changes instead of claiming or overwriting them.

External-editor edge fix:

- An editor may keep the original inode open while Ares renames the source away and installs a replacement.
- The original generation is now retained under `.ares/mutations/<transaction>/source-generation-<index>.bin`.
- If cross-device relocation cannot preserve that inode, the source-adjacent `.old` artifact is retained.
- Late writes through the editor's old handle therefore remain durably reachable.
- Receipts and reconciliation report retained generations as `expected`, `modified`, or `missing`, plus `hasRetainedSourceChanges`.
- Immutable rollback backups remain separate from these live, potentially changing retained inodes.
- In inode-less exclusive-copy fallbacks, final identity is captured only after write, chmod, and sync.

Directory freedom:

- `resolveWorkspacePath` preserves guarded approval and bypass authority for absolute external paths.
- `mutationWorkspaceForPaths` selects the target's nearest real project root and journals the edit there.
- Ares edits the selected external project directly. It does not write inside the original workspace and copy the result outward.
- One atomic operation cannot silently span unrelated projects/filesystem roots; callers split it into one transaction per project.
- This is not an OS sandbox. An authorized opaque shell process can still intentionally access undeclared machine paths.

### 4. Read, repository instructions, PDF, shell, and output reliability

Primary files:

- `packages/tools/src/Read.ts`
- `packages/core/src/repositoryInstructions.ts`
- `packages/tools/src/Bash.ts`
- `packages/tools/src/PowerShell.ts`
- `packages/tools/src/ShellSupervisor.ts`
- `packages/tools/src/ShellRegistry.ts`
- `packages/tools/src/BashOutput.ts`
- `packages/tools/src/KillShell.ts`
- `packages/core/src/providers/toolSchema.ts`

Read behavior:

- Streams text instead of loading an arbitrary file into model context.
- Computes a full-file SHA-256 read stamp while retaining only a bounded page.
- Bounds line count, pathological single-line width, and model-facing bytes.
- Lists directories, handles supported images through the vision channel, rejects binary decoding, and reports empty files clearly.
- PDF extraction is lazy, input-size bounded, page bounded, model-output bounded, and read-stamped.
- A first PDF page larger than 50 KiB is truncated truthfully and continuation advances to the next page, avoiding an infinite same-offset loop.
- Scanned/image-only PDF pages are reported; OCR is not invented.

Repository instructions:

- `ARES.md`, `CRIX.md`, `AGENTS.md`, and `CLAUDE.md` are discovered root-to-leaf with same-directory precedence.
- Claims belong to one Session and are content-hash versioned. A changed rule is reattached.
- Approved/bypass external projects discover their own bounded project root and instructions instead of inheriting only the original workspace.
- Relative shell `target_paths` resolve from the command's effective `cwd`, not the Session's initial workspace.
- Newly encountered mutation rules are surfaced before effects and require a corrected retry after the model sees them.

Shell behavior:

- Bash and PowerShell share one model-facing schema: command, description, timeout, cwd, target paths, and background mode.
- Foreground output preserves bounded inline text while spooling complete decoded interleaved output.
- Non-zero commands return structured failure truth including exit code and touched files.
- Background execution returns a durable shell ID; output is cursor-readable and the process can be stopped explicitly.

### 5. Explicit plan/build architecture

Primary files:

- `packages/core/src/planArtifact.ts`
- `packages/tools/src/PlanMode.ts`
- `packages/cli/src/entry/sessionPlanModes.ts`
- `packages/cli/src/entry/sessionFactory.ts`

Rules:

- Coding wording does not auto-enter plan mode. Only an explicit durable transition does.
- Plan mode removes effectful capabilities except the narrowly scoped living-plan update path.
- Plan drafts have stable identity, exact revision bytes, and hashes. Refinement updates the same logical artifact.
- Exiting plan mode proposes the exact active revision; it cannot self-approve merely because a host has no prompt channel.
- Approval, build authority, and a synthetic build handoff commit atomically for the exact revision/hash.
- Build context pins the approved plan ID/hash/body until settlement.
- A newer draft invalidates older build authority.
- Task/Operator/Conductor child scopes do not inherit owner plan-transition/approval tools.

### 6. Durable Task, Conductor, Operator, and Garrison composition

Primary files:

- `packages/core/src/childSessionComposition.ts`
- `packages/core/src/childSessionVerifier.ts`
- `packages/core/src/subagents.ts`
- `packages/tools/src/Task.ts`
- `packages/core/src/conductor.ts`
- `packages/tools/src/Conductor.ts`
- `packages/operator/src/dispatcher.ts`
- `packages/garrison/src/sessions.ts`
- `packages/cli/src/entry/garrisonCmd.ts`

Shared composition now provides:

- Real parent/child Session links and stable child/input IDs.
- Fresh read-stamp maps and fresh verifier instances per child/workspace.
- Live persona, memory, repository-instruction, context-source hash, hook, summarizer, and cleanup inheritance.
- Durable SQLite mutation/verification debt, including restart rescheduling.
- Separate execution status and proof-bearing `workStatus`.
- Exactly-once completion handoff for detached jobs.

Task jobs:

- Foreground and detached Task use real child Sessions.
- `task_id` continuation reconnects to the same child.
- Detached Task state is leased and restartable.

Conductor:

- Keeps typed DAGs, reducers, budgets, bounded repair, and overlap checks.
- Build leaves work in durable complete-copy branches rather than empty temporary directories.
- Dependency trees are independently materialized; mutable owner dependency junctions are not shared.
- Changed symlinks fail closed.
- Each writing leaf must carry green verifier evidence before it is eligible to merge.
- Disjoint verified leaves prepare one combined phase-wide mutation transaction. No branch lands until the entire phase operation set validates.
- A lost fleet boundary reconnects using deterministic leaf/fleet identities instead of creating duplicate writers.

Operator/Garrison:

- Worker sessions use the same composition and proof rules.
- Red worker proof cannot be overwritten by a green high-level reality probe.
- Production Garrison reschedules red verification debt after canonical restart.

### 7. Background jobs and restart semantics

Primary files:

- `packages/tools/src/ShellSupervisor.ts`
- `packages/tools/src/ShellRegistry.ts`
- `packages/core/src/sessionKernel/store.ts`
- `packages/core/src/subagents.ts`

Task/background jobs use durable leases and can restart work when the harness has semantic replay authority.

Detached shell supervision is deliberately different:

- The supervisor process and output spool survive an Ares host/app restart on the same running OS.
- PID/token/heartbeat/output cursor/status live in durable state.
- If the operating system kills the process or the machine reboots and process identity is lost, the job becomes `orphaned`.
- Ares does not relaunch an arbitrary shell command automatically because that could duplicate an irreversible effect.

### 8. Compaction, context, and memory

Primary files:

- `packages/core/src/queryEngine.ts`
- `packages/core/src/session.ts`
- `packages/core/src/codingJournal.ts`
- `packages/tools/src/Memory.ts`
- `packages/cli/src/entry/turnPipeline.ts`

Compaction/context:

- Heavy compaction is checked at settled model boundaries, not only once at turn start.
- The complete prior recap is the next summary anchor; it is not repeatedly clipped into a telephone-game fragment.
- Old history remains canonical; context epochs project a summary plus retained verbatim tail.
- Current-file state can be re-pinned deliberately.
- Context source hashes version the system baseline, repository rules, memory, journal, and other live sources.
- Compaction timestamps are exact protocol timestamps persisted into SQLite. Restart projection therefore matches the pre-restart history exactly.

Memory:

- Ares keeps Living Memory, CodingJournal, and the Markdown Memory tool.
- Markdown memory now uses a cross-process lease and exact-byte compare-and-swap.
- `expectedVersion` turns concurrent same-snapshot updates into explicit conflicts instead of lost writes.
- Non-cooperating edits made after a Memory read are preserved.
- Project and ARES_HOME user memory use the same version contract.

### 9. Formatter/LSP feedback and proof-bearing completion

Primary files:

- `packages/core/src/postMutationFeedback.ts`
- `packages/tools/src/postMutationFeedback.ts`
- `packages/core/src/verifier.ts`
- `packages/core/src/childSessionVerifier.ts`
- `packages/protocol/src/types.ts`

Behavior:

- Successful committed mutations schedule grouped formatter/LSP/static feedback.
- Results are bound to the committed file hashes, so stale diagnostics cannot certify newer bytes.
- Slow formatters are killed and output is bounded; committed user bytes are not reverted just because optional feedback failed.
- Verification debt is tracked by mutation/evidence generation.
- Behavioral, visual, and spec gates are proof inputs rather than generic prose reminders.
- `turn_end.status` reports execution termination; `workStatus` separately reports verified/unverified/blocked/not-applicable truth.
- A completed-but-unverified child writer cannot satisfy a fleet/parent work contract.

### 10. Surface integration and packaging

The reconstruction is wired through interactive chat, daemon, production Garrison, Task, Conductor, and Operator rather than existing only in unit helpers.

Important surface/package files include:

- `packages/cli/src/entry/sessionFactory.ts`
- `packages/cli/src/entry/chat.ts`
- `packages/cli/src/entry/daemon.ts`
- `packages/cli/src/entry/engineTools.ts`
- `packages/cli/src/entry/garrisonCmd.ts`
- `packages/cli/src/entry/operatorCmd.ts`
- `packages/garrison/src/sessions.ts`
- `scripts/package-tauri-runtime.mjs`
- `tauri/src-tauri/src/main.rs`
- `tauri/src/App.tsx`

`better-sqlite3` and `pdfjs-dist` packaging/runtime resolution were included. PDF runtime assets/license handling and the desktop packaged runtime were verified.

## Final adversarial findings and fixes

An independent final edge review found five issues. All were fixed:

1. **Open editor handle data loss:** successful cleanup could unlink an original inode after an editor wrote late bytes through its still-open handle. Fixed with retained source-generation artifacts and reconciliation state.
2. **Effectful compatibility forks:** bare `runForkedTurn` call sites could fail the new effect-host seal. Fixed with automatic canonical Session hosting, stable input replay, and explicit dynamic-effect metadata.
3. **External project instructions:** approved/bypass shell targets skipped the target repository's own rules, and relative targets used the wrong base. Fixed with bounded external-root discovery and effective-cwd resolution.
4. **Oversized first PDF page:** the first extracted page could exceed the 50 KiB model-facing cap. Fixed with UTF-8-safe truncation, truthful omission text, and forward continuation.
5. **Inode-less exclusive-copy identity:** fallback identity was captured before write/chmod/sync. Fixed by claiming only the final synced generation.

Additional verification-discovered fixes:

- A read-only adapted tool was initially mistaken for dynamically effectful because every adapter has a classifier. Explicit `mayHaveEffects` metadata now carries the real composition contract.
- Retrying a callerless orphan initially added default `source: user-input` to an older `{content}` payload and caused an idempotency conflict. Default source is now omitted from canonical payloads; work-item is persisted only when non-default.
- Protocol message timestamps are now preserved when appending to the kernel, eliminating microcompaction restart drift.

## Verification evidence

Final checks were run after the last code changes:

```text
pnpm verify
  1,522 tests discovered
  1,519 passed
  0 failed
  3 explicit platform/optional skips

node --test --test-concurrency=2 \
  packages/core/dist/conductor.test.js \
  packages/core/dist/conductorReplay.test.js \
  packages/core/dist/sessionLease.test.js \
  packages/core/dist/sessionKernel/sessionIntegration.test.js \
  packages/core/dist/sessionKernel/sessionKernel.test.js
  74 passed / 74

pnpm --dir tauri build:web
  passed; 2,496 modules transformed

pnpm --dir tauri build:runtime
  passed; packaged at tauri/src-tauri/runtime

cargo check --manifest-path tauri\src-tauri\Cargo.toml
  passed

git diff --check
  no whitespace errors (only existing CRLF normalization warnings)
```

Focused edge coverage also passed for effectful fork replay, exact compaction epochs, external-directory freedom, external repository rules, bounded PDF continuation, transactional mutation races, child-session composition, background jobs, PostToolUse settlement, formatter/LSP feedback, and Memory CAS.

## Explicit boundaries — do not accidentally “fix” these into unsafe behavior

- **External connectors:** an interrupted payment/publish/message/deploy remains `effect_unknown` unless that tool supplies an observational reconciler. Generic code cannot infer whether a remote effect happened.
- **Opaque shell authority:** user-authorized shell remains powerful. Ares is not an OS security namespace.
- **Machine reboot:** lost detached-shell process identity becomes `orphaned`; arbitrary commands are not blindly relaunched.
- **Changed symlinks:** Conductor rejects them instead of guessing at a byte-file merge.
- **Scanned PDFs:** Read reports no extractable text; OCR is a separate capability.
- **Identity-less filesystems:** uncertainty becomes a recoverable conflict rather than an overwrite.
- **Test escape hatch:** `QueryEngine.forTesting` is only for deterministic tests/evaluations.
- **Model quality:** the harness prevents classes of state/effect failures; it cannot prove every model decision is correct.

## Crash/consistency contracts

The architecture report defines twenty named invariants (K1-K20). The most important continuation rules are:

- Every provider/tool effect belongs to a durably admitted logical input.
- One sender cannot execute or stream another sender's request.
- One expired generation cannot settle state after takeover.
- Tool result exposure never precedes durable settlement.
- Ambiguous effects are never silently auto-replayed.
- An input is consumed only after a durable terminal boundary.
- Plan authority names exact approved bytes.
- Context epochs are immutable projections over canonical history.
- External changes are preserved rather than claimed as Ares output.
- A failed command cannot erase evidence of files it mutated.
- One child cannot lend stale proof to another.
- Only verified writing leaves are merge-eligible.

## Recommended reading order for Claude

1. `docs/exports/2026-08-01-claude-handoff.md` — this handoff.
2. `docs/CODING-HARNESS-ARCHITECTURE.md` — detailed OpenCode comparison, diagrams, invariants, boundaries, and source map.
3. `packages/core/src/sessionKernel/migrations.ts`, `store.ts`, `coordinator.ts` — durable substrate.
4. `packages/core/src/session.ts` — production lifecycle and recovery composition.
5. `packages/core/src/queryEngine.ts` — model/tool loop, compaction, effect phases, completion truth.
6. `packages/core/src/workspaceMutation.ts` — editor transaction/recovery semantics.
7. `packages/core/src/childSessionComposition.ts` and `packages/core/src/conductor.ts` — durable delegation and verified phase settlement.
8. `packages/tools/src/Read.ts`, `_shared.ts`, `ShellSupervisor.ts`, `Memory.ts`, and `PlanMode.ts` — model-facing reliability contracts.
9. New regression tests under `tests/` and compiled kernel tests under `packages/core/src/sessionKernel/`.
10. `docs/exports/2026-08-01-opencode-ares-chat-transcript.md` — full user-visible history and original rationale.

## Working-tree guidance

- The working tree is intentionally large and dirty: more than 10,000 tracked inserted lines plus new kernel/tool/test files.
- Existing changes are the reconstruction. Do not reset, checkout, stash, or regenerate wholesale.
- There is no reconstruction commit yet.
- If continuing, begin with `git status --short`, read the architecture report, and preserve unrelated user changes.
- Use focused tests while editing, then rerun `pnpm check` and `pnpm verify` for any core/session/tool change.
- Runtime packaging must finish before `cargo check`; running those concurrently can temporarily hide packaged files and produce a false Rust failure.

## Key new files

```text
docs/CODING-HARNESS-ARCHITECTURE.md
packages/cli/src/entry/sessionPlanModes.ts
packages/core/src/childSessionComposition.ts
packages/core/src/childSessionVerifier.ts
packages/core/src/conductorReplay.test.ts
packages/core/src/planArtifact.ts
packages/core/src/postMutationFeedback.ts
packages/core/src/providers/toolSchema.ts
packages/core/src/repositoryInstructions.ts
packages/core/src/sessionKernel/*
packages/core/src/sessionLease.test.ts
packages/core/src/workspaceMutation.ts
packages/tools/src/ApplyPatch.ts
packages/tools/src/ShellSupervisor.ts
packages/tools/src/postMutationFeedback.ts
tests/apply-patch-tool.test.mjs
tests/background-jobs-durable.test.mjs
tests/child-session-composition.test.mjs
tests/child-session-verifier.test.mjs
tests/coding-harness-reconstruction.test.mjs
tests/conductor-worktree-transaction.test.mjs
tests/effect-settlement.test.mjs
tests/effectful-engine-host.test.mjs
tests/explicit-plan-boundary.test.mjs
tests/garrison-production-verifier.test.mjs
tests/memory-markdown-cas.test.mjs
tests/operator-dispatcher-verifier.test.mjs
tests/persona-gate.test.mjs
tests/plan-build-handoff.test.mjs
tests/plan-mode-state.test.mjs
tests/plan-session-composition.test.mjs
tests/post-mutation-feedback.test.mjs
tests/report-upload-size.test.mjs
tests/session-canonical-authority.test.mjs
tests/session-final-boundary-recovery.test.mjs
tests/shell-failure-contract.test.mjs
tests/shell-output-spill.test.mjs
tests/subagent-durable-replay.test.mjs
tests/tool-result-recovery.test.mjs
tests/tool-schema-narrowing.test.mjs
tests/tool-session-state.test.mjs
tests/transactional-edit-write.test.mjs
tests/workspace-freedom.test.mjs
tests/workspace-mutation.test.mjs
```

## Final status

The requested reconstruction is complete and verified. Ares now has the architecture needed for serious long-horizon coding without silently losing admitted requests, crossing sender ownership, duplicating ambiguous effects, forgetting approved plan state, corrupting concurrent/external edits, or merging unverified child work.

The next useful action is review/commit packaging—not another ground-up rewrite—unless a new concrete bug or feature request is identified.
