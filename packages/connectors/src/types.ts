// The vendor-neutral browser interface (Ares v5 / O6 / concept C6).
//
// Ares owns this interface; the engine (Playwright, Chrome MCP, …) is a
// swappable adapter. DOM-first by design — find elements by role/label from the
// accessibility tree (precise, robust) and fall to pixels/vision only when
// structure can't express the target. Every adapter implements this same shape,
// so the rest of Ares never knows or cares which browser is underneath.

export interface AccessibilityNode {
  role: string;
  name?: string;
  /** A stable handle the connector can act on (label, role+name, or selector). */
  selector: string;
}

export interface Screenshot {
  format: "png";
  /** base64-encoded image bytes. */
  bytes: string;
  width?: number;
  height?: number;
}

export interface BrowserState {
  url: string;
  title?: string;
}

export interface ConsoleEntry {
  /** log | info | warn | error | debug */
  type: string;
  text: string;
  /** ISO timestamp when captured. */
  at: string;
}

export interface BrowserConnector {
  readonly name: string;
  /** How this browser was acquired: "cdp:<url>" = attached to a real, already-
   *  running browser (the user's logged-in session); "launch:<label>" = a
   *  browser Ares launched itself (its own persistent profile). Lets callers
   *  tell the owner WHOSE browser the tabs/actions belong to. */
  readonly strategy?: string;
  navigate(url: string): Promise<BrowserState>;
  /** DOM-first targeting: the structured tree, preferred over pixels. */
  accessibilityTree(): Promise<AccessibilityNode[]>;
  fillByLabel(label: string, value: string): Promise<void>;
  clickByRole(role: string, name: string): Promise<void>;
  screenshot(): Promise<Screenshot>;
  state(): Promise<BrowserState>;
  close(): Promise<void>;
  /** Click the first element matching a CSS selector or visible text — the
   *  flexible path for verifying UI (buttons, links, tabs). Animates the cursor. */
  clickByText?(query: string): Promise<void>;
  /** Type into an element by CSS selector (when label targeting won't reach it). */
  fillBySelector?(selector: string, value: string): Promise<void>;
  /** Captured console output since the page loaded — read errors after acting. */
  consoleLogs?(opts?: { onlyErrors?: boolean; limit?: number }): Promise<ConsoleEntry[]>;
  /** Evaluate JS in the page and return the JSON-serializable result — inspect
   *  state, call functions, verify behavior. */
  evaluate?(js: string): Promise<unknown>;
  /** Tabs currently reachable through the browser control channel. This is
   *  intentionally metadata-only: cookies and storage never leave the browser. */
  tabs?(): Promise<Array<{ index: number; url: string; title?: string; active: boolean }>>;
  /** Rebind this connector to an already-open tab. Returns false when no tab
   *  matches, allowing the caller to navigate the Ares-owned page instead. */
  attachToExisting?(query: string): Promise<boolean>;
}
