// @ares/connectors — the reach into the world (Ares v5 / O6+).
//
// A vendor-neutral BrowserConnector (DOM-first + screenshot), browser actions
// as audited Effects (they flow through the O2 rails), and the screenshot
// filmstrip for visual proof. The engine is swappable: MockBrowser for tests,
// Playwright (opt-in) for real headless autonomy, more adapters later.

export type {
  BrowserConnector,
  AccessibilityNode,
  Screenshot,
  BrowserState,
} from "./types.js";

export { MockBrowser, type MockPage } from "./mockBrowser.js";

export { Filmstrip, type FilmstripEntry } from "./filmstrip.js";

export { browserActionEffect, navigateEffect, fillEffect, clickEffect, type BrowserEffectOptions } from "./effects.js";

export {
  createPlaywrightBrowser,
  acquireBrowserPage,
  browserLaunchAttempts,
  findInstalledChromium,
  parseCdpPorts,
  type PlaywrightOptions,
  type LaunchAttempt,
  type AcquireOptions,
  type AcquiredPage,
} from "./playwrightBrowser.js";

export {
  detectChallenge,
  challengePrompt,
  runChallengeHandoff,
  type ChallengeInfo,
  type ChallengeKind,
  type ChallengeSurface,
  type HumanCheckHandler,
  type HumanCheckOutcome,
  type HandoffResult,
} from "./challenge.js";
