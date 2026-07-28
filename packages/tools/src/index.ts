// @ares/tools — one file per tool.
// Each exports a Tool<I, O> built with buildTool() from _shared.ts.

export * from "./_shared.js";

export { ReadTool } from "./Read.js";
export { WriteTool } from "./Write.js";
export { EditTool, nearMissHint, looksLineNumberPrefixed } from "./Edit.js";
export { ApplyIntentTool, type ApplyIntentOutput } from "./ApplyIntent.js";
export { safeOverwrite, assessShrink, type SafeOverwriteOptions, type SafeOverwriteResult, type ShrinkVerdict } from "./safeWrite.js";
export { GlobTool } from "./Glob.js";
export { GrepTool, regexInputProblem } from "./Grep.js";
export { BashTool } from "./Bash.js";
export { PowerShellTool } from "./PowerShell.js";
export { LspTool, type LspOutput, type LspLocation } from "./LSP.js";
export { TodoStore, makeTodoWriteTool, type TodoWriteOutput } from "./TodoWrite.js";
export { makeTaskTool, type SubagentRunner, type TaskOutput } from "./Task.js";
export {
  makeCodingBackendTool,
  buildAresHarnessPrompt,
  detectBackend,
  BACKENDS,
  type BackendName,
  type BackendSpec,
  type CodingBackendDeps,
  type CodingBackendOutput,
} from "./CodingBackend.js";
export {
  makeConductorTool,
  exampleValidator,
  exampleHinter,
  type ConductorToolDeps,
} from "./Conductor.js";
export {
  makeWebFetchTool,
  htmlToText,
  type WebFetchOutput,
  type Summarizer,
} from "./WebFetch.js";
export {
  looksJsGated,
  discoverCdpEndpoint,
  renderOverCdp,
  cdpRenderer,
  type JsRenderer,
  type CdpRenderOptions,
} from "./cdpRender.js";
export {
  makeWebSearchTool,
  duckDuckGoLite,
  parseDuckDuckGoLite,
  defaultSearchChain,
  braveSearch,
  tavilySearch,
  searxngSearch,
  withFallback,
  type WebSearchResult,
  type WebSearchOutput,
  type SearchBackend,
} from "./WebSearch.js";
export {
  makeImageSearchTool,
  duckDuckGoImages,
  braveImages,
  type ImageResult,
  type ImageSearchOutput,
} from "./ImageSearch.js";
export {
  CodebaseSearchTool,
  type CodebaseSearchHit,
  type CodebaseSearchOutput,
} from "./CodebaseSearch.js";
export { FindAndEditTool, type FindAndEditOutput, type FindAndEditChange } from "./FindAndEdit.js";
export { CodeModeTool, type CodeModeOutput } from "./CodeMode.js";
export {
  ShellRegistry,
  type ShellSnapshot,
  type ShellLaunchOptions,
} from "./ShellRegistry.js";
export { makeBashOutputTool, type BashOutputResult } from "./BashOutput.js";
export { makeKillShellTool, type KillShellOutput } from "./KillShell.js";
export { McpListToolsTool, McpCallTool, HttpMcpClient, listMcpServerTools, type McpListOutput, type McpCallOutput } from "./Mcp.js";
export { SkillsListTool, SkillReadTool, type SkillsListOutput, type SkillReadOutput, type SkillSummary } from "./Skills.js";
export { MemoryTool, type MemoryOutput, type MemoryItem } from "./Memory.js";
export {
  ComputerUseTool,
  makeComputerUseTool,
  mapImageToVirtual,
  shotScale,
  normalizeActionCoords,
  type ComputerActionRunner,
  type ComputerUseOutput,
  type RunnerInput,
  type ShotMeta,
} from "./ComputerUse.js";
export { DeployTool, type DeployOutput } from "./Deploy.js";
export { StripeTool, type StripeOutput } from "./Stripe.js";
export { EmailTool, type EmailOutput } from "./Email.js";
export { RequestUserActionTool, type RequestUserActionOutput } from "./RequestUserAction.js";
export { makeEnterPlanModeTool, makeExitPlanModeTool, type PlanModeState } from "./PlanMode.js";
export { WeatherTool, getWeatherText, type WeatherOutput, type WeatherCondition, type WeatherForecast } from "./Weather.js";
export { RemindTool, setRemindScheduler, type RemindOutput, type SchedulerLike } from "./Remind.js";
export { ConnectTool, type ConnectOutput } from "./Connect.js";
export { GoogleCalendarTool, type GoogleCalendarOutput } from "./GoogleCalendar.js";
export { GmailTool, type GmailOutput } from "./Gmail.js";
export { SpotifyTool, type SpotifyOutput } from "./Spotify.js";

import { ReadTool } from "./Read.js";
import { WriteTool } from "./Write.js";
import { EditTool } from "./Edit.js";
import { ApplyIntentTool } from "./ApplyIntent.js";
import { GlobTool } from "./Glob.js";
import { GrepTool } from "./Grep.js";
import { BashTool } from "./Bash.js";
import { PowerShellTool } from "./PowerShell.js";
import { LspTool } from "./LSP.js";
import { CodebaseSearchTool } from "./CodebaseSearch.js";
import { FindAndEditTool } from "./FindAndEdit.js";
import { CodeModeTool } from "./CodeMode.js";
import { McpListToolsTool, McpCallTool } from "./Mcp.js";
import { SkillsListTool, SkillReadTool } from "./Skills.js";
import { MemoryTool } from "./Memory.js";
import { ComputerUseTool } from "./ComputerUse.js";
import { DeployTool } from "./Deploy.js";
import { StripeTool } from "./Stripe.js";
import { EmailTool } from "./Email.js";
import { RequestUserActionTool } from "./RequestUserAction.js";
import { WeatherTool } from "./Weather.js";
import { RemindTool } from "./Remind.js";
import { ConnectTool } from "./Connect.js";
import { GoogleCalendarTool } from "./GoogleCalendar.js";
import { GmailTool } from "./Gmail.js";
import { SpotifyTool } from "./Spotify.js";

/** The default tool set wired into a fresh Session. */
export const DEFAULT_TOOLS = process.platform === "win32"
  ? [
      ReadTool,
      WriteTool,
      EditTool,
      ApplyIntentTool,
      GlobTool,
      GrepTool,
      CodebaseSearchTool,
      LspTool,
      PowerShellTool,
      BashTool,
      FindAndEditTool,
      CodeModeTool,
      McpListToolsTool,
      McpCallTool,
      SkillsListTool,
      SkillReadTool,
      MemoryTool,
      ComputerUseTool,
      DeployTool,
      StripeTool,
      EmailTool,
      RequestUserActionTool,
      WeatherTool,
      RemindTool,
      ConnectTool,
      GoogleCalendarTool,
      GmailTool,
      SpotifyTool,
    ] as const
  : [
      ReadTool,
      WriteTool,
      EditTool,
      ApplyIntentTool,
      GlobTool,
      GrepTool,
      CodebaseSearchTool,
      LspTool,
      BashTool,
      PowerShellTool,
      FindAndEditTool,
      CodeModeTool,
      McpListToolsTool,
      McpCallTool,
      SkillsListTool,
      SkillReadTool,
      MemoryTool,
      DeployTool,
      StripeTool,
      EmailTool,
      RequestUserActionTool,
      WeatherTool,
      RemindTool,
      ConnectTool,
      GoogleCalendarTool,
      GmailTool,
      SpotifyTool,
    ] as const;
