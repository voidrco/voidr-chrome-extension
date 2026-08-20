/**
 * playwright-crx implementation of the QuickRunDriver interface.
 *
 * playwright-crx (pinned 0.15.0) bundles the full Playwright client + a CDP
 * transport backed by chrome.debugger. It runs in any extension context with
 * the "debugger" permission — here, the side panel document (kept alive while
 * the panel is open, which sidesteps most MV3 service-worker suspension
 * issues; the chrome.storage.session run mirror covers panel closure).
 *
 * Locator building is structural (parsed IR expressions → Locator calls) —
 * MV3 pages cannot eval the stored `page.getByRole(...)` strings.
 */

import { crx } from 'playwright-crx';
import type { CrxApplication, Locator, Page } from 'playwright-crx';
import type { ParsedLocator } from './locator-parser';
import type { DriverPage, DriverTarget, QuickRunDriver } from './driver';

// crx allows a single CrxApplication per extension; keep it for the panel's
// lifetime and reuse across runs (attach/detach per run instead).
let appPromise: Promise<CrxApplication> | null = null;

async function getCrxApp(): Promise<CrxApplication> {
  if (!appPromise) {
    appPromise = (async () => {
      const existing = await crx.get().catch(() => undefined);
      if (existing) return existing;
      return crx.start();
    })().catch((err) => {
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
}

function buildLocator(page: Page, parsed: ParsedLocator): Locator {
  switch (parsed.method) {
    case 'getByTestId':
      return page.getByTestId(parsed.arg);
    case 'getByRole':
      // Roles in the IR come from screenmap ARIA data; Playwright validates at
      // call time, and an invalid role is just a candidate miss.
      return page.getByRole(parsed.arg as Parameters<Page['getByRole']>[0], {
        name: parsed.options?.name,
        exact: parsed.options?.exact,
      });
    case 'getByLabel':
      return page.getByLabel(parsed.arg, { exact: parsed.options?.exact });
    case 'getByPlaceholder':
      return page.getByPlaceholder(parsed.arg, { exact: parsed.options?.exact });
    case 'getByText':
      return page.getByText(parsed.arg, { exact: parsed.options?.exact });
    case 'locator':
      return parsed.options?.hasText
        ? page.locator(parsed.arg, { hasText: parsed.options.hasText })
        : page.locator(parsed.arg);
  }
}

class CrxTarget implements DriverTarget {
  constructor(private readonly locator: Locator) {}

  click(timeoutMs: number): Promise<void> {
    return this.locator.click({ timeout: timeoutMs });
  }

  fill(value: string, timeoutMs: number): Promise<void> {
    return this.locator.fill(value, { timeout: timeoutMs });
  }

  async selectOption(value: string, timeoutMs: number): Promise<void> {
    await this.locator.selectOption(value, { timeout: timeoutMs });
  }

  setChecked(checked: boolean, timeoutMs: number): Promise<void> {
    return checked
      ? this.locator.check({ timeout: timeoutMs })
      : this.locator.uncheck({ timeout: timeoutMs });
  }
}

class CrxPage implements DriverPage {
  constructor(private readonly page: Page) {}

  async goto(url: string, timeoutMs: number): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  }

  currentUrl(): string {
    return this.page.url();
  }

  async waitForUrl(pattern: RegExp, timeoutMs: number): Promise<void> {
    await this.page.waitForURL(pattern, { timeout: timeoutMs });
  }

  async resolveCandidate(parsed: ParsedLocator, timeoutMs: number): Promise<DriverTarget | null> {
    try {
      const locator = buildLocator(this.page, parsed).first();
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      return new CrxTarget(locator);
    } catch {
      return null; // candidate miss — the engine tries the next one
    }
  }
}

export class CrxQuickRunDriver implements QuickRunDriver {
  readonly name = 'playwright-crx@0.15.0';

  async attach(tabId: number): Promise<DriverPage> {
    const app = await getCrxApp();
    const page = await app.attach(tabId);
    // Never let a quick run hang on Playwright's 30s defaults; per-step and
    // per-candidate budgets are enforced by the engine on top of this.
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(15_000);
    return new CrxPage(page);
  }

  async detach(tabId: number): Promise<void> {
    try {
      const app = await getCrxApp();
      await app.detach(tabId);
    } catch {
      // Already detached (tab closed, debugger cancelled, previous cleanup).
    }
  }
}

/**
 * Reattach guard for a stale run (panel closed mid-run, extension reloaded):
 * force-release the chrome.debugger attachment so the next run can attach.
 */
export async function forceReleaseTab(tabId: number): Promise<void> {
  try {
    const app = await crx.get().catch(() => undefined);
    if (app) await app.detach(tabId);
  } catch {
    /* fall through to the raw CDP detach */
  }
  await new Promise<void>((resolve) => {
    try {
      chrome.debugger.detach({ tabId }, () => {
        void chrome.runtime.lastError; // "not attached" is the good case
        resolve();
      });
    } catch {
      resolve();
    }
  });
}
