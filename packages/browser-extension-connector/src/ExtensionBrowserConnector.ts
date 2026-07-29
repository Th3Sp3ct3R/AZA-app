import type { BrowserConnector, BrowserState, Screenshot, AccessibilityNode } from "@ares/connectors";
import { BrowserBridgeServer } from "./BrowserBridgeServer.js";

export class ExtensionBrowserConnector implements BrowserConnector {
  readonly name = "browser-extension";
  readonly strategy = "extension:native-messaging";
  private tabId: number | null = null;
  constructor(private readonly bridge: BrowserBridgeServer) {}

  async tabs() {
    const tabs = await this.bridge.request({ op: "tabs.list" }) as Array<{ id?: number; url?: string; title?: string; active?: boolean }>;
    return tabs.filter((tab) => Number.isInteger(tab.id)).map((tab) => ({ index: tab.id!, url: tab.url ?? "", title: tab.title, active: !!tab.active }));
  }

  async attachToExisting(query: string): Promise<boolean> {
    const needle = query.trim().toLowerCase();
    const tabs = await this.tabs();
    const match = needle
      ? tabs.find((tab) => tab.url.toLowerCase().includes(needle) || (tab.title ?? "").toLowerCase().includes(needle))
      : tabs.find((tab) => tab.active) ?? tabs[0];
    if (!match) return false;
    await this.bridge.request({ op: "tab.attach", tabId: match.index });
    this.tabId = match.index;
    return true;
  }

  async navigate(url: string): Promise<BrowserState> {
    const tabId = this.requiredTab();
    await this.bridge.request({ op: "page.navigate", tabId, params: { url }, capabilities: ["observe", "interact"] });
    return this.state();
  }

  async accessibilityTree(): Promise<AccessibilityNode[]> {
    const result = await this.bridge.request({ op: "ax.snapshot", tabId: this.requiredTab(), params: { depth: 8 }, capabilities: ["observe"] }) as { nodes?: any[] };
    return (result.nodes ?? []).slice(0, 500).map((node) => ({ role: node.role?.value ?? "unknown", name: node.name?.value, selector: String(node.backendDOMNodeId ?? node.nodeId ?? "") }));
  }

  async fillByLabel(label: string, value: string): Promise<void> {
    await this.bridge.request({ op: "element.fill", tabId: this.requiredTab(), params: { name: label, value }, capabilities: ["observe", "interact"] });
  }

  async clickByRole(role: string, name: string): Promise<void> {
    await this.bridge.request({ op: "element.click", tabId: this.requiredTab(), params: { role, name }, capabilities: ["observe", "interact"] });
  }

  async clickByText(query: string): Promise<void> {
    const looksLikeSelector = /[.#\[\]>:]/.test(query);
    await this.bridge.request({ op: "element.click", tabId: this.requiredTab(), params: looksLikeSelector ? { selector: query } : { name: query }, capabilities: ["observe", "interact"] });
  }

  async fillBySelector(selector: string, value: string): Promise<void> {
    await this.bridge.request({ op: "element.fill", tabId: this.requiredTab(), params: { selector, value }, capabilities: ["observe", "interact"] });
  }

  async evaluate(expression: string): Promise<unknown> {
    return this.bridge.request({ op: "runtime.evaluate", tabId: this.requiredTab(), params: { expression }, capabilities: ["observe", "debug"] });
  }

  async screenshot(): Promise<Screenshot> {
    const result = await this.bridge.request({ op: "page.screenshot", tabId: this.requiredTab(), capabilities: ["observe"] }) as { data: string };
    return { format: "png", bytes: result.data };
  }

  async state(): Promise<BrowserState> {
    const tab = await this.bridge.request({ op: "page.state", tabId: this.requiredTab(), capabilities: ["observe"] }) as { url?: string; title?: string };
    return { url: tab.url ?? "", title: tab.title };
  }

  async close(): Promise<void> {
    if (this.tabId !== null) await this.bridge.request({ op: "tab.detach", tabId: this.tabId }).catch(() => undefined);
    this.tabId = null;
  }

  private requiredTab(): number {
    if (this.tabId === null) throw new Error("no extension browser tab attached; call tabs/attach first");
    return this.tabId;
  }
}
