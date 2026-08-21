// Per-provider coding overlays.
//
// One prompt for every model was leaving real quality on the table: model
// families fail in DIFFERENT ways, and a rule that fixes one is noise to
// another. opencode ships a separate prompt per family for exactly this
// reason, and each of theirs is visibly aimed at that model's known weakness
// (their Anthropic prompt opens with URL discipline; their GPT prompt argues
// for minimal diffs and names OpenAI's parallel-call mechanism; their Kimi
// prompt insists on acting instead of describing).
//
// Keep each overlay SHORT and CORRECTIVE. This is a delta on top of craft.ts,
// not a second doctrine — anything true for every model belongs in the core.
// Evidence for these deltas comes from the owner's own session sweep.

export type ProviderFamily =
  | "anthropic"
  | "openai"
  | "kimi"
  | "deepseek"
  | "google"
  | "ollama"
  | "openrouter"
  | "ares"
  | "mock"
  | (string & {});

const ANTHROPIC = `## For this model

- Never generate or guess a URL unless you are confident it helps with programming, or the owner supplied it. Prefer URLs found in the repo or returned by a search tool over one you recall.
- You batch tool calls well — keep doing it. Independent reads, greps and globs belong in one turn.
- Your failure mode is over-explaining before acting. When the next move is obvious, make it and report after.`;

const OPENAI = `## For this model

- **Prefer the smallest correct change.** Your failure mode is over-engineering: extra helpers, extra names, extra tests, backwards-compatibility code nobody asked for. Do not add compat shims unless there is a concrete need (persisted data, shipped behaviour, external consumers, an explicit request); if it's unclear, ask one short question instead of guessing.
- Keep logic in one function unless it is genuinely composable or reused.
- Parallelise tool calls whenever possible — especially file reads. Never chain shell commands with separators like \`echo "===";\` to fake batching; it renders badly and hides failures.`;

const KIMI = `## For this model

- **Take action with tools — do not just describe the solution in text.** If the request involves creating, modifying, or running code or files, you MUST make the actual change. Describing what you would do is not doing it, and it is your most common failure.
- **When a request could be read as either a question or a task, treat it as a task.** Only reply in plain text when the owner clearly wants an explanation, a greeting, or an opinion.
- You can emit several tool calls in one response. If the next calls do not interfere, make them in parallel — this matters a great deal to your effectiveness.
- Follow each tool's schema exactly. Do not add commentary explaining a tool call; the call speaks for itself.`;

const DEEPSEEK = `## For this model

- **Converge.** Your failure mode is looping — re-reading files you already have, re-running a check that already passed, or re-searching the same thing reworded. Before any call, ask what NEW information it produces; if none, act instead.
- Verify once, decisively, then report. Repeated confirmation of the same fact is not thoroughness.
- Keep reasoning proportionate: think before a hard decision, not before every routine edit.`;

const GOOGLE = `## For this model

- Answer with the work, not a summary of the work. Lead with the action or the result.
- Keep formatting light — prose and short lists. Heavy nested markdown obscures the answer in a terminal.
- Confirm the file's current contents before editing rather than relying on recall.`;

const LOCAL = `## For this model

- You are running locally, so keep each step small and concrete: one file, one command, one check.
- Prefer exact tools (Grep for a symbol, Read for a file) over broad exploration.
- If a task is genuinely beyond your context, say so plainly and suggest the owner switch models rather than producing a confident guess.`;

const BY_FAMILY: Record<string, string> = {
  anthropic: ANTHROPIC,
  openai: OPENAI,
  kimi: KIMI,
  deepseek: DEEPSEEK,
  google: GOOGLE,
  gemini: GOOGLE,
  ollama: LOCAL,
};

/**
 * Resolve the overlay for a provider family + model id.
 *
 * The MODEL id is consulted too, because aggregators (OpenRouter, the Ares
 * gateway, a custom OpenAI-compatible base URL) serve many families behind one
 * provider name — routing on the provider alone would hand a Kimi model the
 * generic overlay.
 */
export function providerOverlay(family: ProviderFamily | undefined, model = ""): string {
  const id = `${family ?? ""}/${model}`.toLowerCase();
  if (/kimi|moonshot|\bk\d/.test(id)) return KIMI;
  if (/claude|anthropic|opus|sonnet|haiku/.test(id)) return ANTHROPIC;
  if (/gpt|o[34]-|codex|openai/.test(id)) return OPENAI;
  if (/deepseek/.test(id)) return DEEPSEEK;
  if (/gemini|google/.test(id)) return GOOGLE;
  if (/ollama|llama|qwen|mistral|phi/.test(id)) return LOCAL;
  return BY_FAMILY[(family ?? "").toLowerCase()] ?? "";
}
