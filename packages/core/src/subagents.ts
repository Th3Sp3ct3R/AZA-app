// Subagent registry + runner.
//
// A subagent is a child QueryEngine with a scoped tool whitelist and a
// focused system prompt. It runs stateless: one prompt in, one summary
// out. The parent's main context stays clean — only the summary is fed
// back, not the subagent's 30 file reads.
//
// Built-in types (extend via SubagentRegistry.register):
//   general-purpose  — full tool access; for research that may write code
//   researcher       — read-only; returns structured findings report
//   code-reviewer    — read + lints; inspects the pending diff
//
// The Task tool (in @ares/tools) takes a SubagentRunner and calls run().
// The CLI builds the runner with the parent's provider so children use
// the same model.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Usage } from "@ares/protocol";
import { runForkedTurn } from "./forkedTurn.js";
import type { EngineTool, Provider, QueryEngineConfig } from "./queryEngine.js";
import { SubagentJournal, renderSubagentHandoff, type SubagentHandoff } from "./subagentJournal.js";

export interface SubagentTypeDef {
  name: string;
  description: string;
  /** Tool names the subagent is allowed to call. If undefined → all parent tools. */
  toolWhitelist?: readonly string[];
  /** Subagent-specific system prompt. Prepended ahead of the parent's base. */
  systemPrompt: string;
  /** Max iterations the inner QueryEngine will run before bailing. */
  maxTurns?: number;
  /** "fast" = run on the host's cheap/fast lane when one is wired (searching
   *  doesn't need the frontier model — this is what keeps wide exploration
   *  cheap and quick). Default: inherit the parent model. */
  modelPreference?: "fast" | "inherit";
}

export interface SubagentRunRequest {
  subagent_type: string;
  description: string;
  prompt: string;
  parentSessionId?: string;
  workspace: string;
  signal?: AbortSignal;
  /** Forward child activity to the parent so a running subagent isn't invisible. */
  onProgress?: (data: unknown) => void;
  /** Parent-session permission prompt, forwarded into the child engine so a
   *  subagent touching paths outside the workspace ASKS instead of hard-dying
   *  ("escapes workspace and no permission prompt is available"). The child's
   *  request pauses its own tool watchdog and surfaces in the parent UI like
   *  any other prompt; the resulting dir-scope grant lands in the shared
   *  path-permission store, unblocking sibling leaves without re-prompting. */
  requestPermission?: QueryEngineConfig["requestPermission"];
}

export interface SubagentRunResult {
  id: string;
  type: string;
  status: "completed" | "failed" | "cancelled";
  /** The summary text the subagent produced — fed back as the tool result. */
  summary: string;
  toolCallCount: number;
  durationMs: number;
  usage: Usage;
  /** Persistent transcript path under <workspace>/.ares/agents/<id>/. */
  transcriptPath: string;
  /** Structured flight-recorder handoff: what the child actually DID (from its
   *  engine events), not what its prose claims. Also rendered into `summary`. */
  handoff: SubagentHandoff;
}

export interface SubagentRunner {
  run(req: SubagentRunRequest): Promise<SubagentRunResult>;
  listTypes(): SubagentTypeDef[];
  has(name: string): boolean;
}

// ─── Built-in subagent types ───────────────────────────────────────────

const RESEARCHER_PROMPT = `You are a focused RESEARCHER subagent inside the Ares harness.

Your job: investigate the question your parent asked and return ONE structured findings report. You have READ-ONLY tools. Do not attempt edits.

Process:
1. Use CodebaseSearch / Grep / Glob / Read aggressively to gather evidence.
2. Read every file path you reference to confirm what's actually there.
3. Use file_path:line_number for every claim you make.

Output format (return this and only this):
  ## Findings
  - <claim with file_path:line proof>
  - <claim with file_path:line proof>

  ## Open questions
  - <thing you couldn't confirm and why>

  ## Recommended next step
  <one sentence>

Be concise. Your parent will read your summary and decide next moves.`;

const CODE_REVIEWER_PROMPT = `You are a CODE REVIEWER subagent inside the Ares harness.

Your job: review the pending changes and return ONE structured review. You have READ + Lints + Bash (read-only commands like git diff) tools. Do not edit.

Process:
1. Run \`git diff\` (or whatever scope the parent passed) to see the changes.
2. Inspect changed files with Read.
3. Run Lints/Grep to find regressions, dead code, missing tests.
4. Cite every finding with file_path:line.

Output format:
  ## Blockers (must fix)
  - file:line — what + why + suggested fix

  ## Concerns (should consider)
  - file:line — what + why

  ## Nits (optional polish)
  - file:line — what

  ## Test coverage
  <one sentence on whether tests cover the change>

  ## Verdict
  ship / fix-blockers / needs-discussion`;

const GENERAL_PURPOSE_PROMPT = `You are a GENERAL-PURPOSE subagent inside the Ares harness.

You have full tool access. Your job: complete the task your parent assigned, then return a structured summary.

Process:
1. Use TodoWrite to plan if the task has 3+ steps.
2. Use tools to act. Read before Edit. Verify changes you made.
3. Be exhaustive — your parent is not watching the details. They only see your final summary.
4. Track file_path:line for every notable change.

Output format:
  ## Done
  - <what you completed, with file_path:line>

  ## Verified
  - <commands you ran and their result>

  ## Blockers
  - <anything you couldn't finish>

  ## Files changed
  - file/path:linecount`;

const VERIFIER_PROMPT = `You are a VERIFICATION specialist inside the Ares harness. Your job is NOT to confirm the work works — it is to try to BREAK it.

You have two documented failure patterns; catch yourself doing them and do the opposite:
1. Verification avoidance — faced with a check, you find reasons not to run it: you read the code, narrate what you WOULD test, write "PASS," and move on. Reading is not verification. Run it.
2. Seduced by the first 80% — a passing test suite or a polished surface makes you want to pass it, without noticing half the buttons do nothing, state vanishes on refresh, or the backend crashes on bad input. The last 20% is your entire value.

The caller may spot-check by RE-RUNNING your commands — if a PASS has no command output, or output that doesn't reproduce, your report is rejected.

You are TOOL-RESTRICTED: you have Read/Grep/Glob/Bash/PowerShell/WebFetch — NO Edit, Write, or Task. You physically cannot fix-and-pass. If something is broken, you report it broken. (You may write ephemeral scripts to a temp dir via Bash redirection when an inline command isn't enough; clean up.)

REQUIRED BASELINE (do these first, when applicable):
1. Read CLAUDE.md/README/package.json for the real build & test commands. If pointed at a plan/spec, read it — that's the success criteria.
2. Run the build. A broken build is an automatic FAIL.
3. Run the test suite. Failing tests are an automatic FAIL. (But test results are CONTEXT, not proof — the implementer is an LLM; its tests may be mock-heavy happy-path.)
4. Run type-checkers/linters if configured.
Then exercise the actual change directly (run it / call it / hit the endpoint) and check OUTPUTS against expectations — not just status codes.

ADVERSARIAL PROBES (pick the ones that fit — a PASS requires at least one, with its result):
- Boundary values: 0, -1, empty, huge, unicode, MAX_INT
- Concurrency: parallel requests to create-if-not-exists paths (duplicates? lost writes?)
- Idempotency: same mutating request twice
- Orphan ops: reference/delete IDs that don't exist
If all your checks are "returns 200" or "suite passes," you verified the happy path, not correctness. Go break something.

OUTPUT FORMAT — every check MUST be:
### Check: <what you're verifying>
**Command run:** <exact command>
**Output observed:** <actual output, copy-pasted, not paraphrased>
**Result: PASS** (or FAIL — with Expected vs Actual)

A check with no Command-run block is a SKIP, not a PASS.

End with EXACTLY one line the caller parses:
VERDICT: PASS
or
VERDICT: FAIL
or
VERDICT: PARTIAL

PARTIAL is for environmental limits ONLY (no test framework, tool unavailable, server won't start) — never for "I'm unsure if it's a bug." If you can run the check, decide PASS or FAIL.`;

const EXPLORER_PROMPT = `You are an EXPLORER subagent — a fast, read-only search specialist. The caller needs a CONCLUSION, not file dumps.

Rules:
- Sweep wide: Glob/Grep/CodebaseSearch across every plausible location and naming convention, then Read only the excerpts that decide the answer.
- Never paste large file bodies back. Cite findings as file_path:line with a one-line quote at most.
- Cover the misses too: say where you looked that turned up empty, so the caller doesn't re-search it.
- Finish with a tight summary: ANSWER (the conclusion), EVIDENCE (citations), NOT FOUND (searched-but-absent).
Speed matters — prefer three broad searches over ten narrow ones.`;

export const BUILT_IN_SUBAGENT_TYPES: SubagentTypeDef[] = [
  {
    name: "explorer",
    description:
      "Fast read-only search specialist for broad fan-out exploration — 'find every place X happens', 'which files own Y'. Runs on the cheap/fast model lane when available, so use it liberally to keep YOUR context lean: it reads the excerpts so you don't have to. Returns a conclusion with file:line citations, never file dumps.",
    toolWhitelist: ["Read", "Glob", "Grep", "CodebaseSearch", "LSP"],
    systemPrompt: EXPLORER_PROMPT,
    maxTurns: 20,
    modelPreference: "fast",
  },
  {
    name: "verifier",
    description:
      "Adversarial verification subagent — 'done means proven'. Tool-restricted (Read/Grep/Glob/Bash/PowerShell/WebFetch; NO Edit/Write/Task) so it cannot fix-and-pass. Runs the real build/tests + adversarial probes and returns a VERDICT: PASS/FAIL/PARTIAL with copy-pasted command evidence. Invoke after non-trivial coding work (3+ edits, backend/infra changes) BEFORE claiming done — the caller may re-run its commands to confirm.",
    toolWhitelist: ["Read", "Glob", "Grep", "CodebaseSearch", "LSP", "Bash", "PowerShell", "WebFetch"],
    systemPrompt: VERIFIER_PROMPT,
    maxTurns: 30,
  },
  {
    name: "general-purpose",
    description:
      "Full-access subagent for research tasks that may also need to write code. Best when the task is well-scoped and self-contained.",
    systemPrompt: GENERAL_PURPOSE_PROMPT,
    maxTurns: 40,
  },
  {
    name: "researcher",
    description:
      "Read-only subagent for 'where is X handled', 'how does Y work', 'find all uses of Z' style questions. Returns a structured findings report.",
    toolWhitelist: ["Read", "Glob", "Grep", "CodebaseSearch", "LSP"],
    systemPrompt: RESEARCHER_PROMPT,
    maxTurns: 25,
  },
  {
    name: "code-reviewer",
    description:
      "Read + diagnostics subagent for reviewing pending changes. Returns structured findings (blockers / concerns / nits / verdict).",
    toolWhitelist: ["Read", "Glob", "Grep", "CodebaseSearch", "LSP", "Bash", "PowerShell"],
    systemPrompt: CODE_REVIEWER_PROMPT,
    maxTurns: 20,
  },
];

// ─── Registry + Runner ─────────────────────────────────────────────────

export class SubagentRegistry {
  private readonly types = new Map<string, SubagentTypeDef>();

  constructor(initial: readonly SubagentTypeDef[] = BUILT_IN_SUBAGENT_TYPES) {
    for (const t of initial) this.types.set(t.name, t);
  }

  register(def: SubagentTypeDef): void {
    this.types.set(def.name, def);
  }

  list(): SubagentTypeDef[] {
    return [...this.types.values()];
  }

  get(name: string): SubagentTypeDef | undefined {
    return this.types.get(name);
  }
}

export interface SubagentRunnerOptions {
  registry: SubagentRegistry;
  /** Provider used by all subagent runs. Same model as the parent. */
  provider: Provider;
  model: string;
  /** Cheap/fast model id ON THE SAME PROVIDER for types that prefer it
   *  (explorer). Absent → those types inherit the parent model. */
  fastModel?: string;
  /** Full parent tool catalog. The runner filters by whitelist per type. */
  parentTools: readonly EngineTool[];
  /** Base system prompt the subagent sees AFTER its type-specific prompt. */
  baseSystemPrompt: string;
  /** Optional global ceiling layered over each subagent type's own limit. */
  maxTurns?: number | (() => number | undefined);
}

export class AresSubagentRunner implements SubagentRunner {
  constructor(private readonly opts: SubagentRunnerOptions) {}

  listTypes(): SubagentTypeDef[] {
    return this.opts.registry.list();
  }

  has(name: string): boolean {
    return this.opts.registry.get(name) !== undefined;
  }

  async run(req: SubagentRunRequest): Promise<SubagentRunResult> {
    const def = this.opts.registry.get(req.subagent_type);
    if (!def) {
      throw new Error(
        `unknown subagent_type: ${req.subagent_type}. Available: ${this.listTypes()
          .map((t) => t.name)
          .join(", ")}`,
      );
    }

    const allowedTools = def.toolWhitelist
      ? this.opts.parentTools.filter((t) => def.toolWhitelist!.includes(t.schema.name))
      : this.opts.parentTools;

    const id = `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    const transcriptDir = path.join(req.workspace, ".ares", "agents", id);
    // Flight recorder: fed live from the child's engine events, flushed to disk
    // incrementally so a crashed subagent leaves evidence. Never fails the run.
    const journal = new SubagentJournal(transcriptDir, {
      id,
      type: req.subagent_type,
      description: req.description,
    });

    const systemPrompt = `${def.systemPrompt}\n\n---\n\n${this.opts.baseSystemPrompt}`;

    const configuredMaxTurns =
      typeof this.opts.maxTurns === "function" ? this.opts.maxTurns() : this.opts.maxTurns;
    const typeMaxTurns = def.maxTurns ?? 30;
    const maxTurns =
      configuredMaxTurns === undefined ? typeMaxTurns : Math.min(typeMaxTurns, configuredMaxTurns);

    // Re-enter the ONE loop as a fork: fresh read-stamp isolation + a work-item
    // seed (not a faked chat turn) are guaranteed inside runForkedTurn.
    // Fast-lane types (explorer) run on the cheap model when the host wired one
    // — searching doesn't need the frontier model, and it keeps fan-out cheap.
    const model =
      def.modelPreference === "fast" && this.opts.fastModel ? this.opts.fastModel : this.opts.model;
    const result = await runForkedTurn({
      config: {
        provider: this.opts.provider,
        model,
        systemPrompt,
        tools: allowedTools,
        workspace: req.workspace,
        signal: req.signal,
        maxTurns,
        // Bubble child permission prompts to the parent session (absent in
        // headless runs, where out-of-workspace access stays denied).
        requestPermission: req.requestPermission,
      },
      sessionId: id,
      seed: { kind: "work-item", text: req.prompt },
      onEvent: (ev) => {
        journal.record(ev);
        if (ev.type === "tool_start") {
          // Surface what the child is doing so the parent UI shows real activity
          // instead of a frozen "Delegating…".
          req.onProgress?.({
            kind: "subagent_activity",
            agentId: id,
            type: req.subagent_type,
            tool: (ev as { name?: string }).name,
            activity: (ev as { activityDescription?: string }).activityDescription,
          });
        }
      },
    });

    const events = result.events;
    const usage: Usage = result.usage;
    const toolCallCount = events.filter((e) => e.type === "tool_start").length;
    const status: SubagentRunResult["status"] = result.status === "completed" ? "completed" : "failed";

    const hasAssistant = result.history.some((m) => m.role === "assistant");
    // A child that died before writing prose still owes the parent an
    // explanation — surface its last tool errors instead of the bare
    // "(subagent produced no text output)" that made fleet deaths undebuggable.
    const lastToolErrors = events
      .filter((e) => e.type === "tool_error")
      .slice(-3)
      .map((e) => `- ${String((e as { error?: unknown }).error ?? "").slice(0, 300)}`);
    const emptyText =
      (hasAssistant ? "(subagent produced no text output)" : "(subagent did not respond)") +
      (lastToolErrors.length ? `\nLast tool error(s):\n${lastToolErrors.join("\n")}` : "");
    const finalText = result.finalText || emptyText;

    // Structured handoff: what the child actually DID (from engine events), fed
    // back alongside its prose so the parent doesn't have to trust the claims.
    const handoff = await journal.finish(result.status);
    const summary = `${finalText}\n\n${renderSubagentHandoff(handoff)}`;

    // Persist transcript best-effort.
    let transcriptPath = path.join(transcriptDir, "transcript.jsonl");
    try {
      await mkdir(transcriptDir, { recursive: true });
      await writeFile(
        path.join(transcriptDir, "meta.json"),
        JSON.stringify(
          {
            id,
            type: req.subagent_type,
            description: req.description,
            parentSessionId: req.parentSessionId,
            startedAt: new Date(startedAt).toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            status,
            toolCallCount,
            usage,
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      await writeFile(transcriptPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    } catch {
      transcriptPath = "";
    }

    return {
      id,
      type: req.subagent_type,
      status,
      summary,
      toolCallCount,
      durationMs: Date.now() - startedAt,
      usage,
      transcriptPath,
      handoff,
    };
  }
}
