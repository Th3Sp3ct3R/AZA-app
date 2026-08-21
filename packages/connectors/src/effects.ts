// Browser actions as Effects (Ares v5 / O6 × O2).
//
// Every browser action is an EffectSpec, so it flows through the same rails as
// everything else: audited in the ledger, gated by irreversibility + leash,
// haltable by the kill switch. A navigate is reversible (free to commit); a
// form submit (click) is irreversible by default, so on a short leash it is
// STAGED for approval rather than fired blindly. Each committed action records
// a filmstrip frame for visual proof.

import type { EffectSpec, Irreversibility } from "@ares/effects";
import type { BrowserConnector, BrowserState } from "./types.js";
import type { Filmstrip } from "./filmstrip.js";

export interface BrowserEffectOptions {
  filmstrip?: Filmstrip;
  idemPrefix?: string;
  /** Override the action's default irreversibility (click only, usually). */
  irreversibility?: Irreversibility;
}

async function frame(browser: BrowserConnector, opts: BrowserEffectOptions, action: string): Promise<void> {
  if (!opts.filmstrip) return;
  const [shot, state] = await Promise.all([browser.screenshot(), browser.state()]);
  await opts.filmstrip.record({ action, url: state.url, screenshot: shot });
}

export function browserActionEffect<R>(
  kind: string,
  irreversibility: Irreversibility,
  key: string,
  run: () => Promise<R>,
  opts: BrowserEffectOptions,
): EffectSpec<R> {
  return {
    kind,
    domain: "browser",
    irreversibility,
    idempotencyKey: `${opts.idemPrefix ?? "browser"}:${key}`,
    async simulate() {
      // Dry-run: no navigation, no input, no click. Reality is untouched.
      return undefined;
    },
    async commit() {
      return run();
    },
  };
}

export function navigateEffect(browser: BrowserConnector, url: string, opts: BrowserEffectOptions = {}): EffectSpec<BrowserState> {
  return browserActionEffect(
    "browser.navigate",
    opts.irreversibility ?? "reversible",
    `nav:${url}`,
    async () => {
      const state = await browser.navigate(url);
      await frame(browser, opts, `navigate ${url}`);
      return state;
    },
    opts,
  );
}

export function fillEffect(browser: BrowserConnector, label: string, value: string, opts: BrowserEffectOptions = {}): EffectSpec<void> {
  return browserActionEffect(
    "browser.fill",
    opts.irreversibility ?? "reversible",
    `fill:${label}`,
    async () => {
      await browser.fillByLabel(label, value);
      await frame(browser, opts, `fill ${label}`);
    },
    opts,
  );
}

export function clickEffect(browser: BrowserConnector, role: string, name: string, opts: BrowserEffectOptions = {}): EffectSpec<void> {
  return browserActionEffect(
    "browser.click",
    opts.irreversibility ?? "recoverable",
    `click:${role}:${name}`,
    async () => {
      await browser.clickByRole(role, name);
      await frame(browser, opts, `click ${role}:${name}`);
    },
    opts,
  );
}
