/**
 * Driver abstraction for the quick-runner.
 *
 * playwright-crx is community-maintained: the engine (quick-run.ts) only sees
 * this interface, so the underlying implementation (crx-driver.ts today, a
 * raw chrome.debugger CDP mini-driver if crx ever bit-rots) is swappable
 * without touching the run loop or the UI.
 */

import type { ParsedLocator } from './locator-parser';

/** A resolved on-page element the driver can act on. */
export interface DriverTarget {
  click(timeoutMs: number): Promise<void>;
  fill(value: string, timeoutMs: number): Promise<void>;
  selectOption(value: string, timeoutMs: number): Promise<void>;
  setChecked(checked: boolean, timeoutMs: number): Promise<void>;
}

export interface DriverPage {
  goto(url: string, timeoutMs: number): Promise<void>;
  currentUrl(): string;
  waitForUrl(pattern: RegExp, timeoutMs: number): Promise<void>;
  /**
   * Try to resolve ONE locator candidate to a visible element within
   * timeoutMs. Returns null on miss (never throws for a miss) — the engine
   * walks the ranked candidate list, mirroring the compiled resolveTarget.
   */
  resolveCandidate(parsed: ParsedLocator, timeoutMs: number): Promise<DriverTarget | null>;
}

export interface QuickRunDriver {
  readonly name: string;
  /** Attach to an existing tab and return a page handle for it. */
  attach(tabId: number): Promise<DriverPage>;
  /** Detach from the tab. Must be safe to call multiple times. */
  detach(tabId: number): Promise<void>;
}
